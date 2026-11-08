const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'lc-live-2026';
const VIDEOS_DIR = '/tmp/videos';

// Ensure videos dir exists
if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

// State
let currentStream = null;
let streamLogs = [];

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  streamLogs.push(entry);
  if (streamLogs.length > 500) streamLogs.shift();
  console.log(entry);
}

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Extract Google Drive file ID from various URL formats
function extractDriveFileId(url) {
  let match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return null;
}

// Download file from Google Drive (handles large file confirmation)
function downloadFromDrive(fileId, destPath) {
  return new Promise((resolve, reject) => {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

    log(`Downloading from Drive: ${fileId}`);

    const file = fs.createWriteStream(destPath);

    function doDownload(url, redirectCount = 0) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          log(`Redirect to: ${response.headers.location}`);
          doDownload(response.headers.location, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && downloadedBytes % (10 * 1024 * 1024) < chunk.length) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            log(`Download: ${pct}% (${Math.round(downloadedBytes / 1024 / 1024)}MB / ${Math.round(totalBytes / 1024 / 1024)}MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          const stats = fs.statSync(destPath);
          log(`Download complete: ${Math.round(stats.size / 1024 / 1024)}MB`);

          if (stats.size < 100000) {
            const content = fs.readFileSync(destPath, 'utf8');
            if (content.includes('</html>') || content.includes('virus scan')) {
              reject(new Error('Google Drive blocked the download. Make sure the file sharing is set to "Anyone with the link".'));
              return;
            }
          }

          resolve(destPath);
        });

      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    doDownload(downloadUrl);
  });
}

// Start streaming
app.post('/api/stream/start', auth, async (req, res) => {
  if (currentStream) {
    return res.status(400).json({ error: 'A stream is already running. Stop it first.' });
  }

  const { streamUrl, streamKey, videoUrl, loop } = req.body;

  if (!streamKey || !videoUrl) {
    return res.status(400).json({ error: 'streamKey and videoUrl are required.' });
  }

  try {
    // Determine video source
    let videoPath;
    const fileId = extractDriveFileId(videoUrl);

    if (fileId) {
      videoPath = path.join(VIDEOS_DIR, `${fileId}.mp4`);
      if (fs.existsSync(videoPath)) {
        log(`Video already cached: ${videoPath}`);
      } else {
        await downloadFromDrive(fileId, videoPath);
      }
    } else if (videoUrl.startsWith('http')) {
      const filename = `${uuidv4()}.mp4`;
      videoPath = path.join(VIDEOS_DIR, filename);
      await downloadFromDrive(videoUrl, videoPath);
    } else {
      return res.status(400).json({ error: 'Invalid video URL. Use a Google Drive share link.' });
    }

    // Verify it's a valid video
    try {
      execSync(`ffprobe -v quiet -print_format json -show_format "${videoPath}"`);
    } catch (e) {
      return res.status(400).json({ error: 'Downloaded file is not a valid video.' });
    }

    // Build RTMP URL: use custom streamUrl if provided, otherwise default
    const baseUrl = streamUrl && streamUrl.trim()
      ? streamUrl.trim().replace(/\/$/, '')
      : 'rtmps://live-upload.instagram.com:443/rtmp';
    const rtmpUrl = `${baseUrl}/${streamKey}`;

    const inputArgs = loop ? ['-stream_loop', '-1'] : [];

    const ffmpegArgs = [
      ...inputArgs,
      '-re',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-maxrate', '3500k',
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', '60',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      rtmpUrl
    ];

    log(`Starting stream to Instagram...`);
    log(`RTMP: ${baseUrl}/***`);
    log(`Video: ${videoPath}`);
    log(`Loop: ${loop ? 'yes' : 'no'}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    const streamId = uuidv4().slice(0, 8);

    currentStream = {
      id: streamId,
      process: ffmpeg,
      startedAt: new Date().toISOString(),
      videoUrl,
      loop: !!loop
    };

    ffmpeg.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line.includes('Error') || line.includes('error') ||
          line.includes('Stream mapping') || line.includes('Output #') ||
          line.includes('frame=') && Math.random() < 0.01) {
        log(`[ffmpeg] ${line.substring(0, 200)}`);
      }
    });

    ffmpeg.on('close', (code) => {
      log(`Stream ended (exit code: ${code})`);
      currentStream = null;
    });

    ffmpeg.on('error', (err) => {
      log(`Stream error: ${err.message}`);
      currentStream = null;
    });

    // Wait a moment to see if it crashes immediately
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (currentStream) {
      res.json({
        success: true,
        streamId,
        message: 'Stream started! Video is being broadcast to Instagram.'
      });
    } else {
      res.status(500).json({ error: 'Stream failed to start. Check logs.' });
    }

  } catch (err) {
    log(`Error: ${err.message}`);
    currentStream = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop streaming
app.post('/api/stream/stop', auth, (req, res) => {
  if (!currentStream) {
    return res.json({ message: 'No stream running.' });
  }

  log('Stopping stream...');
  currentStream.process.kill('SIGTERM');

  setTimeout(() => {
    if (currentStream) {
      currentStream.process.kill('SIGKILL');
      currentStream = null;
    }
  }, 5000);

  res.json({ success: true, message: 'Stream stopped.' });
});

// Stream status
app.get('/api/stream/status', auth, (req, res) => {
  if (!currentStream) {
    return res.json({ streaming: false });
  }

  res.json({
    streaming: true,
    id: currentStream.id,
    startedAt: currentStream.startedAt,
    videoUrl: currentStream.videoUrl,
    loop: currentStream.loop,
    uptime: Math.round((Date.now() - new Date(currentStream.startedAt).getTime()) / 1000)
  });
});

// Logs
app.get('/api/logs', auth, (req, res) => {
  res.json({ logs: streamLogs.slice(-100) });
});

// Cleanup cached videos
app.post('/api/cache/clear', auth, (req, res) => {
  const files = fs.readdirSync(VIDEOS_DIR);
  files.forEach(f => fs.unlinkSync(path.join(VIDEOS_DIR, f)));
  log(`Cache cleared: ${files.length} files removed`);
  res.json({ success: true, removed: files.length });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', streaming: !!currentStream });
});

app.listen(PORT, () => {
  log(`LC LiveStream running on port ${PORT}`);
});
