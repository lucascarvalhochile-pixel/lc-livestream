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

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

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

function isYouTubeUrl(url) { return /(?:youtube\.com|youtu\.be)/.test(url); }

function getVideoInfo(videoPath) {
  try {
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath}"`, { encoding: 'utf8' });
    const data = JSON.parse(result);
    const vs = data.streams.find(s => s.codec_type === 'video');
    return vs ? { width: vs.width, height: vs.height, codec: vs.codec_name, fps: eval(vs.r_frame_rate) } : null;
  } catch (e) { return null; }
}

function downloadFromDrive(fileId, destPath) {
  return new Promise((resolve, reject) => {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    log(`Downloading from Drive: ${fileId}`);
    const file = fs.createWriteStream(destPath);
    function doDownload(url, rc = 0) {
      if (rc > 5) { reject(new Error('Too many redirects')); return; }
      const protocol = url.startsWith('https') ? https : http;
      protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doDownload(res.headers.location, rc + 1); return; }
        if (res.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${res.statusCode}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let dl = 0;
        res.on('data', (c) => { dl += c.length; if (total > 0 && dl % (10*1024*1024) < c.length) log(`Download: ${Math.round(dl/total*100)}% (${Math.round(dl/1024/1024)}MB / ${Math.round(total/1024/1024)}MB)`); });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const stats = fs.statSync(destPath);
          log(`Download complete: ${Math.round(stats.size/1024/1024)}MB`);
          if (stats.size < 100000) { const c = fs.readFileSync(destPath,'utf8'); if (c.includes('</html>')||c.includes('virus scan')) { reject(new Error('Drive blocked. Set sharing to "Anyone with the link".')); return; } }
          resolve(destPath);
        });
      }).on('error', (err) => { fs.unlink(destPath, ()=>{}); reject(err); });
    }
    doDownload(downloadUrl);
  });
}

function downloadFromYouTube(url, destPath) {
  return new Promise((resolve, reject) => {
    log(`Downloading from YouTube: ${url}`);
    const ytdlp = spawn('yt-dlp', ['-f','bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best','--merge-output-format','mp4','-o',destPath,'--no-playlist','--no-warnings',url]);
    ytdlp.stdout.on('data', (d) => { const l=d.toString().trim(); if(l.includes('%')) log(`[yt-dlp] ${l}`); });
    ytdlp.stderr.on('data', (d) => { const l=d.toString().trim(); if(l) log(`[yt-dlp] ${l}`); });
    ytdlp.on('close', (code) => {
      if (code===0 && fs.existsSync(destPath)) { log(`YouTube download: ${Math.round(fs.statSync(destPath).size/1024/1024)}MB`); resolve(destPath); }
      else reject(new Error(`yt-dlp failed (code ${code})`));
    });
    ytdlp.on('error', reject);
  });
}

// Normalize video to H.264 1080x1920 30fps for clean concat
function normalizeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('md5').update(inputPath).digest('hex').slice(0,8);
    const outputPath = path.join(VIDEOS_DIR, `norm_${hash}.mp4`);
    if (fs.existsSync(outputPath)) { log(`Normalized cached: ${outputPath}`); resolve(outputPath); return; }

    const info = getVideoInfo(inputPath);
    if (!info) { reject(new Error('Cannot read video info')); return; }

    log(`Normalizing: ${info.width}x${info.height} ${info.codec} -> 1080x1920 h264 30fps`);

    let filter;
    if (info.width > info.height) {
      // Horizontal: blur background + center
      filter = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30';
    } else {
      // Vertical: scale to fit 1080x1920
      filter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=30';
    }

    const ff = spawn('ffmpeg', [
      '-i', inputPath,
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-y', outputPath
    ]);

    ff.stderr.on('data', (d) => {
      const l = d.toString().trim();
      if (l.includes('frame=') && Math.random() < 0.05) log(`[normalize] ${l.substring(0,150)}`);
    });

    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        log(`Normalized: ${Math.round(fs.statSync(outputPath).size/1024/1024)}MB`);
        resolve(outputPath);
      } else reject(new Error(`Normalize failed (code ${code})`));
    });
    ff.on('error', reject);
  });
}

async function resolveVideo(videoUrl) {
  const url = videoUrl.trim();
  if (!url) return null;
  let videoPath;
  if (isYouTubeUrl(url)) {
    const hash = require('crypto').createHash('md5').update(url).digest('hex').slice(0,12);
    videoPath = path.join(VIDEOS_DIR, `yt_${hash}.mp4`);
    if (!fs.existsSync(videoPath)) await downloadFromYouTube(url, videoPath);
    else log(`YouTube cached: ${videoPath}`);
  } else {
    const fid = extractDriveFileId(url);
    if (fid) {
      videoPath = path.join(VIDEOS_DIR, `${fid}.mp4`);
      if (!fs.existsSync(videoPath)) await downloadFromDrive(fid, videoPath);
      else log(`Drive cached: ${videoPath}`);
    } else if (url.startsWith('http')) {
      videoPath = path.join(VIDEOS_DIR, `${uuidv4()}.mp4`);
      await downloadFromDrive(url, videoPath);
    } else return null;
  }
  return videoPath;
}

async function resolveAllVideos(urls, forPlaylist) {
  const paths = [];
  for (let i = 0; i < urls.length; i++) {
    log(`Video ${i+1}/${urls.length}: ${urls[i].substring(0,80)}...`);
    let vp = await resolveVideo(urls[i]);
    if (!vp) throw new Error(`Invalid URL: ${urls[i]}`);
    try { execSync(`ffprobe -v quiet -print_format json -show_format "${vp}"`); } catch(e) { throw new Error(`Not a valid video: ${urls[i]}`); }
    // For playlists with multiple videos, normalize each to same format
    if (forPlaylist && urls.length > 1) {
      vp = await normalizeVideo(vp);
    }
    paths.push(vp);
  }
  return paths;
}

function writeConcatFile(videoPaths) {
  const concatPath = path.join(VIDEOS_DIR, 'current_playlist.txt');
  const content = videoPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatPath, content);
  return concatPath;
}

function startFFmpegConcat(concatFile, rtmpUrl, loop) {
  const loopArgs = loop ? ['-stream_loop', '-1'] : [];
  return spawn('ffmpeg', [
    ...loopArgs,
    '-re', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c', 'copy',
    '-f', 'flv', rtmpUrl
  ]);
}

function startSingleFFmpeg(videoPath, rtmpUrl, loop) {
  const info = getVideoInfo(videoPath);
  const isNormalized = videoPath.includes('norm_');

  if (isNormalized) {
    // Already normalized, just copy
    const loopArgs = loop ? ['-stream_loop', '-1'] : [];
    return spawn('ffmpeg', [...loopArgs, '-re', '-i', videoPath, '-c', 'copy', '-f', 'flv', rtmpUrl]);
  }

  // Single video: check if needs conversion
  const loopArgs = loop ? ['-stream_loop', '-1'] : [];
  let filterArgs = [];
  if (info && info.width > info.height) {
    filterArgs = ['-vf', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2'.replace(/;/g, ',')];
    // Complex filter needs -filter_complex
    return spawn('ffmpeg', [
      ...loopArgs, '-re', '-i', videoPath,
      '-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2',
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k',
      '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-f', 'flv', rtmpUrl
    ]);
  }

  return spawn('ffmpeg', [
    ...loopArgs, '-re', '-i', videoPath,
    '-c:v', 'libx264', '-preset', 'fast',
    '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k',
    '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'flv', rtmpUrl
  ]);
}

function attachFFmpegHandlers(ffmpeg) {
  ffmpeg.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('Error') || line.includes('error') ||
        line.includes('Stream mapping') || line.includes('Output #') ||
        line.includes('frame=') && Math.random() < 0.02) {
      log(`[ffmpeg] ${line.substring(0, 200)}`);
    }
  });
  ffmpeg.on('close', (code) => { log(`Stream ended (exit code: ${code})`); currentStream = null; });
  ffmpeg.on('error', (err) => { log(`Stream error: ${err.message}`); currentStream = null; });
}

app.get('/api/defaults', auth, (req, res) => {
  res.json({ streamUrl: DEFAULT_STREAM_URL, streamKey: DEFAULT_STREAM_KEY, account: DEFAULT_ACCOUNT });
});

app.post('/api/stream/start', auth, async (req, res) => {
  if (currentStream) return res.status(400).json({ error: 'A stream is already running. Stop it first.' });

  const { streamUrl, streamKey, videoUrl, videoUrls, loop } = req.body;
  if (!streamKey) return res.status(400).json({ error: 'streamKey is required.' });

  let urls = [];
  if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim());
  else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'At least one video URL is required.' });

  try {
    log(`Preparing ${urls.length} video(s)...`);
    const videoPaths = await resolveAllVideos(urls, true);

    const baseUrl = streamUrl && streamUrl.trim() ? streamUrl.trim().replace(/\/$/,'') : 'rtmps://live-upload.instagram.com:443/rtmp';
    const rtmpUrl = `${baseUrl}/${streamKey}`;

    let ffmpeg, concatFile = null;

    if (videoPaths.length === 1) {
      ffmpeg = startSingleFFmpeg(videoPaths[0], rtmpUrl, !!loop);
    } else {
      concatFile = writeConcatFile(videoPaths);
      ffmpeg = startFFmpegConcat(concatFile, rtmpUrl, !!loop);
    }

    log(`Starting stream to Instagram...`);
    log(`RTMP: ${baseUrl}/***`);
    log(`Videos: ${videoPaths.length} | Loop: ${loop ? 'yes' : 'no'}`);

    const streamId = uuidv4().slice(0, 8);
    currentStream = {
      id: streamId, process: ffmpeg, startedAt: new Date().toISOString(),
      videoUrls: urls, videoPaths, loop: !!loop,
      rtmpUrl, concatFile, streamUrl: baseUrl, streamKey
    };

    attachFFmpegHandlers(ffmpeg);
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

app.post('/api/stream/swap', auth, async (req, res) => {
  if (!currentStream) return res.status(400).json({ error: 'No stream running.' });
  const { videoUrl, videoUrls } = req.body;
  let urls = [];
  if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim());
  else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'At least one video URL is required.' });

  try {
    log(`Hot swap: preparing ${urls.length} new video(s)...`);
    const newPaths = await resolveAllVideos(urls, true);
    if (currentStream.concatFile) {
      const content = newPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(currentStream.concatFile, content);
      currentStream.videoUrls = urls;
      currentStream.videoPaths = newPaths;
      log(`Hot swap: playlist updated.`);
      res.json({ success: true, message: 'Playlist updated. New videos play after the current one finishes.' });
    } else {
      await doImmediateSwap(urls, newPaths);
      res.json({ success: true, message: 'Video swapped! Stream reconnected.' });
    }
  } catch (err) {
    log(`Swap error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stream/swap-now', auth, async (req, res) => {
  if (!currentStream) return res.status(400).json({ error: 'No stream running.' });
  const { videoUrl, videoUrls } = req.body;
  let urls = [];
  if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim());
  else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'At least one video URL is required.' });

  try {
    log(`Immediate swap: preparing ${urls.length} video(s)...`);
    const newPaths = await resolveAllVideos(urls, true);
    await doImmediateSwap(urls, newPaths);
    res.json({ success: true, message: 'Video swapped! Stream reconnected.' });
  } catch (err) {
    log(`Swap error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

async function doImmediateSwap(urls, newPaths) {
  const { rtmpUrl, loop } = currentStream;
  log('Immediate swap: stopping current...');
  currentStream.process.removeAllListeners('close');
  currentStream.process.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));

  let ffmpeg, concatFile = null;
  if (newPaths.length === 1) {
    ffmpeg = startSingleFFmpeg(newPaths[0], rtmpUrl, loop);
  } else {
    concatFile = writeConcatFile(newPaths);
    ffmpeg = startFFmpegConcat(concatFile, rtmpUrl, loop);
  }

  log(`Immediate swap: reconnecting with ${newPaths.length} video(s)...`);
  currentStream.process = ffmpeg;
  currentStream.videoUrls = urls;
  currentStream.videoPaths = newPaths;
  currentStream.concatFile = concatFile;
  attachFFmpegHandlers(ffmpeg);
  await new Promise(r => setTimeout(r, 3000));
  if (currentStream) log('Immediate swap: reconnected!');
  else throw new Error('Stream failed to reconnect.');
}

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
