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

const DEFAULT_STREAM_URL = process.env.DEFAULT_STREAM_URL || '';
const DEFAULT_STREAM_KEY = process.env.DEFAULT_STREAM_KEY || '';
const DEFAULT_ACCOUNT = process.env.DEFAULT_ACCOUNT || '';

if (!fs.existsSync(VIDEOS_DIR)) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
}

let currentStream = null;
let streamLogs = [];

function log(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  streamLogs.push(entry);
  if (streamLogs.length > 500) streamLogs.shift();
  console.log(entry);
}

function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function extractDriveFileId(url) {
  let match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return null;
}

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/.test(url);
}

function downloadFromDrive(fileId, destPath) {
  return new Promise((resolve, reject) => {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    log(`Downloading from Drive: ${fileId}`);
    const file = fs.createWriteStream(destPath);
    function doDownload(url, redirectCount = 0) {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
      const protocol = url.startsWith('https') ? https : http;
      protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doDownload(response.headers.location, redirectCount + 1); return;
        }
        if (response.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${response.statusCode}`)); return; }
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
              reject(new Error('Google Drive blocked. Set sharing to "Anyone with the link".')); return;
            }
          }
          resolve(destPath);
        });
      }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }
    doDownload(downloadUrl);
  });
}

function downloadFromYouTube(url, destPath) {
  return new Promise((resolve, reject) => {
    log(`Downloading from YouTube: ${url}`);
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', destPath,
      '--no-playlist',
      '--no-warnings',
      url
    ]);

    ytdlp.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line.includes('%')) log(`[yt-dlp] ${line}`);
    });

    ytdlp.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) log(`[yt-dlp] ${line}`);
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        log(`YouTube download complete: ${Math.round(stats.size / 1024 / 1024)}MB`);
        resolve(destPath);
      } else {
        reject(new Error(`yt-dlp failed with code ${code}`));
      }
    });

    ytdlp.on('error', (err) => reject(err));
  });
}

// Resolve a single video URL to a local file path
async function resolveVideo(videoUrl) {
  const url = videoUrl.trim();
  if (!url) return null;

  if (isYouTubeUrl(url)) {
    // YouTube URL
    const hash = require('crypto').createHash('md5').update(url).digest('hex').slice(0, 12);
    const videoPath = path.join(VIDEOS_DIR, `yt_${hash}.mp4`);
    if (fs.existsSync(videoPath)) {
      log(`YouTube video already cached: ${videoPath}`);
      return videoPath;
    }
    await downloadFromYouTube(url, videoPath);
    return videoPath;
  }

  const fileId = extractDriveFileId(url);
  if (fileId) {
    const videoPath = path.join(VIDEOS_DIR, `${fileId}.mp4`);
    if (fs.existsSync(videoPath)) {
      log(`Drive video already cached: ${videoPath}`);
      return videoPath;
    }
    await downloadFromDrive(fileId, videoPath);
    return videoPath;
  }

  if (url.startsWith('http')) {
    const filename = `${uuidv4()}.mp4`;
    const videoPath = path.join(VIDEOS_DIR, filename);
    await downloadFromDrive(url, videoPath);
    return videoPath;
  }

  return null;
}

// Create a concat file for FFmpeg playlist
function createConcatFile(videoPaths) {
  const concatPath = path.join(VIDEOS_DIR, `playlist_${uuidv4().slice(0, 8)}.txt`);
  const content = videoPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatPath, content);
  return concatPath;
}

app.get('/api/defaults', auth, (req, res) => {
  res.json({ streamUrl: DEFAULT_STREAM_URL, streamKey: DEFAULT_STREAM_KEY, account: DEFAULT_ACCOUNT });
});

app.post('/api/stream/start', auth, async (req, res) => {
  if (currentStream) return res.status(400).json({ error: 'A stream is already running. Stop it first.' });

  const { streamUrl, streamKey, videoUrl, videoUrls, loop } = req.body;

  if (!streamKey) return res.status(400).json({ error: 'streamKey is required.' });

  // Support both single videoUrl and array videoUrls
  let urls = [];
  if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) {
    urls = videoUrls.filter(u => u && u.trim());
  } else if (videoUrl) {
    urls = [videoUrl];
  }

  if (urls.length === 0) return res.status(400).json({ error: 'At least one video URL is required.' });

  try {
    // Download all videos
    log(`Preparing ${urls.length} video(s)...`);
    const videoPaths = [];
    for (let i = 0; i < urls.length; i++) {
      log(`Video ${i + 1}/${urls.length}: ${urls[i].substring(0, 60)}...`);
      const vp = await resolveVideo(urls[i]);
      if (!vp) return res.status(400).json({ error: `Invalid URL: ${urls[i]}` });
      try {
        execSync(`ffprobe -v quiet -print_format json -show_format "${vp}"`);
      } catch (e) {
        return res.status(400).json({ error: `Not a valid video: ${urls[i]}` });
      }
      videoPaths.push(vp);
    }

    const baseUrl = streamUrl && streamUrl.trim()
      ? streamUrl.trim().replace(/\/$/, '')
      : 'rtmps://live-upload.instagram.com:443/rtmp';
    const rtmpUrl = `${baseUrl}/${streamKey}`;

    let ffmpegArgs;

    if (videoPaths.length === 1) {
      // Single video
      const inputArgs = loop ? ['-stream_loop', '-1'] : [];
      ffmpegArgs = [
        ...inputArgs,
        '-re', '-i', videoPaths[0],
        '-c:v', 'libx264', '-preset', 'fast',
        '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k',
        '-pix_fmt', 'yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-f', 'flv', rtmpUrl
      ];
    } else {
      // Playlist: use concat demuxer
      const concatFile = createConcatFile(videoPaths);
      const loopArgs = loop ? ['-stream_loop', '-1'] : [];
      ffmpegArgs = [
        ...loopArgs,
        '-re', '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-c:v', 'libx264', '-preset', 'fast',
        '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k',
        '-pix_fmt', 'yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-f', 'flv', rtmpUrl
      ];
    }

    log(`Starting stream to Instagram...`);
    log(`RTMP: ${baseUrl}/***`);
    log(`Videos: ${videoPaths.length} | Loop: ${loop ? 'yes' : 'no'}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    const streamId = uuidv4().slice(0, 8);

    currentStream = {
      id: streamId,
      process: ffmpeg,
      startedAt: new Date().toISOString(),
      videoUrls: urls,
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

    ffmpeg.on('close', (code) => { log(`Stream ended (exit code: ${code})`); currentStream = null; });
    ffmpeg.on('error', (err) => { log(`Stream error: ${err.message}`); currentStream = null; });

    await new Promise(resolve => setTimeout(resolve, 3000));

    if (currentStream) {
      res.json({ success: true, streamId, videos: urls.length, message: `Stream started with ${urls.length} video(s)!` });
    } else {
      res.status(500).json({ error: 'Stream failed to start. Check logs.' });
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    currentStream = null;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stream/stop', auth, (req, res) => {
  if (!currentStream) return res.json({ message: 'No stream running.' });
  log('Stopping stream...');
  currentStream.process.kill('SIGTERM');
  setTimeout(() => { if (currentStream) { currentStream.process.kill('SIGKILL'); currentStream = null; } }, 5000);
  res.json({ success: true, message: 'Stream stopped.' });
});

app.get('/api/stream/status', auth, (req, res) => {
  if (!currentStream) return res.json({ streaming: false });
  res.json({
    streaming: true, id: currentStream.id, startedAt: currentStream.startedAt,
    videoUrls: currentStream.videoUrls, loop: currentStream.loop,
    uptime: Math.round((Date.now() - new Date(currentStream.startedAt).getTime()) / 1000)
  });
});

app.get('/api/logs', auth, (req, res) => { res.json({ logs: streamLogs.slice(-100) }); });

app.post('/api/cache/clear', auth, (req, res) => {
  const files = fs.readdirSync(VIDEOS_DIR);
  files.forEach(f => fs.unlinkSync(path.join(VIDEOS_DIR, f)));
  log(`Cache cleared: ${files.length} files removed`);
  res.json({ success: true, removed: files.length });
});

app.get('/health', (req, res) => { res.json({ status: 'ok', streaming: !!currentStream }); });

app.listen(PORT, () => {
  log(`LC LiveStream running on port ${PORT}`);
  if (DEFAULT_ACCOUNT) log(`Default account: ${DEFAULT_ACCOUNT}`);
});
