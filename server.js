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

const OVERLAY_NAME = process.env.OVERLAY_NAME || '';
const OVERLAY_DESTINATIONS = process.env.OVERLAY_DESTINATIONS || '';
const OVERLAY_LOGO_URL = process.env.OVERLAY_LOGO_URL || 'https://lucascarvalhoturismo.com.br/wp-content/uploads/2026/08/lc-logo-white-start.png';
const OVERLAY_CTA = process.env.OVERLAY_CTA || 'Clique no link abaixo e fale no WhatsApp';
const OVERLAY_LOGO_PATH = path.join(VIDEOS_DIR, 'overlay_logo.png');
const SUBTITLE_PATH = path.join(VIDEOS_DIR, 'current_subtitles.srt');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
let currentTopTitle = '';

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

let currentStream = null;
let streamLogs = [];
let overlayReady = false;

function log(msg) {
  const entry = '[' + new Date().toISOString() + '] ' + msg;
  streamLogs.push(entry);
  if (streamLogs.length > 500) streamLogs.shift();
  console.log(entry);
}

function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function downloadOverlayLogo() {
  return new Promise((resolve) => {
    if (!OVERLAY_NAME || !OVERLAY_LOGO_URL) { resolve(false); return; }
    if (fs.existsSync(OVERLAY_LOGO_PATH)) { log('Overlay logo: cached'); resolve(true); return; }
    log('Downloading overlay logo...');
    const file = fs.createWriteStream(OVERLAY_LOGO_PATH);
    function doGet(url, rc) {
      if (rc > 5) { resolve(false); return; }
      const proto = url.startsWith('https') ? https : http;
      proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doGet(res.headers.location, rc + 1); return; }
        if (res.statusCode !== 200) { log('Logo download failed: ' + res.statusCode); resolve(false); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); log('Overlay logo: ready'); resolve(true); });
      }).on('error', (e) => { log('Logo error: ' + e.message); resolve(false); });
    }
    doGet(OVERLAY_LOGO_URL, 0);
  });
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
    const result = execSync('ffprobe -v quiet -print_format json -show_streams -show_format "' + videoPath + '"', { encoding: 'utf8' });
    const data = JSON.parse(result);
    const vs = data.streams.find(s => s.codec_type === 'video');
    return vs ? { width: vs.width, height: vs.height, codec: vs.codec_name, fps: eval(vs.r_frame_rate) } : null;
  } catch (e) { return null; }
}

// Download from Google Drive using curl with cookie jar (handles large file virus scan confirmation)
function downloadFromDrive(fileId, destPath) {
  return new Promise((resolve, reject) => {
    log('Downloading from Drive: ' + fileId);
    const cookieJar = path.join(VIDEOS_DIR, 'gdrive_cookies.txt');
    try {
      // Step 1: Initial request to get confirmation token
      const url1 = 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download';
      execSync('curl -s -L -c "' + cookieJar + '" -o "' + destPath + '" "' + url1 + '"', { timeout: 30000 });
      
      // Check if we got HTML (virus scan page) instead of the video
      const stats1 = fs.statSync(destPath);
      if (stats1.size < 5000000) { // Less than 5MB = probably HTML confirmation page
        const content = fs.readFileSync(destPath, 'utf8');
        if (content.includes('confirm=') || content.includes('virus') || content.includes('</html>') || content.includes('download_warning')) {
          log('Drive: large file confirmation required, retrying with confirm...');
          // Extract confirm token if present
          const confirmMatch = content.match(/confirm=([a-zA-Z0-9_-]+)/);
          const confirmToken = confirmMatch ? confirmMatch[1] : 't';
          
          // Step 2: Download with confirmation token and cookies
          const url2 = 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download&confirm=' + confirmToken;
          fs.unlinkSync(destPath);
          log('Drive: downloading with confirm token...');
          execSync('curl -s -L -b "' + cookieJar + '" -c "' + cookieJar + '" -o "' + destPath + '" "' + url2 + '"', { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
          
          // Verify again
          const stats2 = fs.statSync(destPath);
          if (stats2.size < 5000000) {
            const content2 = fs.readFileSync(destPath, 'utf8');
            if (content2.includes('</html>')) {
              // Last resort: try direct download URL format
              log('Drive: confirm token failed, trying direct format...');
              fs.unlinkSync(destPath);
              const url3 = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&key=AIzaSyC1qbk75NzWBvSaDh6KnUvjbjV0y36XUY0';
              execSync('curl -s -L -o "' + destPath + '" "' + url3 + '"', { timeout: 600000 });
              const stats3 = fs.statSync(destPath);
              if (stats3.size < 5000000) {
                fs.unlinkSync(destPath);
                reject(new Error('Drive download failed. File may not be publicly shared. Go to Drive > Share > Anyone with the link.'));
                return;
              }
            }
          }
        }
      }
      
      // Clean up cookies
      try { fs.unlinkSync(cookieJar); } catch(e) {}
      
      const finalStats = fs.statSync(destPath);
      log('Download complete: ' + Math.round(finalStats.size / 1024 / 1024) + 'MB');
      
      // Final validation: check it's actually a video
      if (finalStats.size < 100000) {
        try {
          const c = fs.readFileSync(destPath, 'utf8');
          if (c.includes('</html>') || c.includes('Sign in')) {
            fs.unlinkSync(destPath);
            reject(new Error('Drive blocked download. Make sure file sharing is set to "Anyone with the link".'));
            return;
          }
        } catch(e) {} // Binary file, that's good
      }
      
      resolve(destPath);
    } catch (e) {
      try { fs.unlinkSync(cookieJar); } catch(ex) {}
      try { fs.unlinkSync(destPath); } catch(ex) {}
      reject(new Error('Drive download error: ' + e.message));
    }
  });
}

function downloadFromYouTube(url, destPath) {
  return new Promise((resolve, reject) => {
    log('Downloading from YouTube: ' + url);
    const ytdlp = spawn('yt-dlp', ['-f','bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best','--merge-output-format','mp4','-o',destPath,'--no-playlist','--no-warnings',url]);
    ytdlp.stdout.on('data', (d) => { const l=d.toString().trim(); if(l.includes('%')) log('[yt-dlp] '+l); });
    ytdlp.stderr.on('data', (d) => { const l=d.toString().trim(); if(l) log('[yt-dlp] '+l); });
    ytdlp.on('close', (code) => {
      if (code===0 && fs.existsSync(destPath)) { log('YouTube download: '+Math.round(fs.statSync(destPath).size/1024/1024)+'MB'); resolve(destPath); }
      else reject(new Error('yt-dlp failed (code '+code+')'));
    });
    ytdlp.on('error', reject);
  });
}

function transcribeVideo(videoPath) {
  return new Promise(async (resolve) => {
    if (!GROQ_API_KEY) { log('No GROQ_API_KEY, skipping transcription'); resolve(false); return; }
    const audioPath = path.join(VIDEOS_DIR, 'temp_audio.mp3');
    try {
      log('Extracting audio for transcription...');
      execSync('ffmpeg -i "' + videoPath + '" -vn -acodec libmp3lame -q:a 4 -y "' + audioPath + '"', { timeout: 120000 });
      const stats = fs.statSync(audioPath);
      log('Audio extracted: ' + Math.round(stats.size/1024/1024) + 'MB');
      if (stats.size > 25 * 1024 * 1024) { execSync('ffmpeg -i "' + audioPath + '" -t 1500 -y "' + audioPath + '.tmp.mp3"', { timeout: 60000 }); fs.renameSync(audioPath + '.tmp.mp3', audioPath); }
      log('Sending to Groq Whisper...');
      const curlResult = execSync('curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" -H "Authorization: Bearer ' + GROQ_API_KEY + '" -F "file=@' + audioPath + '" -F "model=whisper-large-v3" -F "response_format=srt" -F "language=pt"', { encoding: 'utf8', timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
      if (curlResult && curlResult.includes('-->')) {
        fs.writeFileSync(SUBTITLE_PATH, curlResult.trim());
        log('Transcription complete: ' + curlResult.trim().split('\n').length + ' lines SRT');
        resolve(true);
      } else { log('Transcription failed: ' + curlResult.substring(0, 200)); resolve(false); }
    } catch (e) { log('Transcription error: ' + e.message); resolve(false); }
    finally { try { fs.unlinkSync(audioPath); } catch(e) {} }
  });
}

function getOverlayFilters() {
  if (!OVERLAY_NAME || !overlayReady) return null;
  const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontReg = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const hasLogo = fs.existsSync(OVERLAY_LOGO_PATH);
  const esc = (t) => t.replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:');
  const filters = [];
  if (currentTopTitle) {
    filters.push('drawbox=x=0:y=ih*0.14:w=iw:h=ih*0.04:color=black@0.4:t=fill');
    filters.push("drawtext=text='" + esc(currentTopTitle) + "':fontfile=" + fontBold + ":fontsize=h*0.02:fontcolor=white:x=(w-text_w)/2:y=h*0.148");
  }
  filters.push('drawbox=x=0:y=ih*0.66:w=iw*0.7:h=ih*0.073:color=black@0.35:t=fill');
  filters.push('drawbox=x=0:y=ih*0.66:w=iw*0.45:h=3:color=0x0100FE@0.85:t=fill');
  filters.push("drawtext=text='" + esc(OVERLAY_NAME) + "':fontfile=" + fontBold + ":fontsize=h*0.023:fontcolor=white:x=w*0.037:y=h*0.672");
  if (OVERLAY_DESTINATIONS) { filters.push("drawtext=text='" + esc(OVERLAY_DESTINATIONS) + "':fontfile=" + fontReg + ":fontsize=h*0.014:fontcolor=0xCDD9FF@0.7:x=w*0.037:y=h*0.702"); }
  if (OVERLAY_CTA) { filters.push("drawtext=text='" + esc(OVERLAY_CTA) + "':fontfile=" + fontReg + ":fontsize=h*0.013:fontcolor=white@0.7:x=w*0.052:y=h*0.763:box=1:boxcolor=white@0.06:boxborderw=12"); }
  if (fs.existsSync(SUBTITLE_PATH)) { filters.push("subtitles=" + SUBTITLE_PATH.replace(/:/g,'\\\\:') + ":force_style='FontSize=24,FontName=DejaVu Sans,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Alignment=2,MarginV=350'"); }
  return { filters, hasLogo };
}

function normalizeVideo(inputPath, useOverlay) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('md5').update(inputPath + OVERLAY_NAME + (useOverlay?'1':'0') + currentTopTitle).digest('hex').slice(0,8);
    const outputPath = path.join(VIDEOS_DIR, 'norm_' + hash + '.mp4');
    if (fs.existsSync(outputPath)) { log('Normalized cached: ' + outputPath); resolve(outputPath); return; }
    const info = getVideoInfo(inputPath);
    if (!info) { reject(new Error('Cannot read video info')); return; }
    log('Normalizing: ' + info.width + 'x' + info.height + ' -> 1080x1920 30fps');
    const overlay = (useOverlay && info.width > info.height) ? getOverlayFilters() : null;
    let filter; const inputs = ['-i', inputPath];
    if (info.width > info.height) { filter = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2'; }
    else { filter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black'; }
    if (overlay) { filter += ',' + overlay.filters.join(','); if (overlay.hasLogo) { inputs.push('-i', OVERLAY_LOGO_PATH); filter += '[prelogo];[1:v]scale=200:-1[logo];[prelogo][logo]overlay=W-w-40:H*0.177:format=auto'; } }
    filter += ',fps=30';
    const ff = spawn('ffmpeg', [...inputs, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'fast', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-y', outputPath]);
    ff.stderr.on('data', (d) => { const l = d.toString().trim(); if (l.includes('frame=') && Math.random() < 0.05) log('[normalize] '+l.substring(0,150)); if (l.includes('Error')||l.includes('error')) log('[normalize] '+l.substring(0,200)); });
    ff.on('close', (code) => { if (code === 0 && fs.existsSync(outputPath)) { log('Normalized: '+Math.round(fs.statSync(outputPath).size/1024/1024)+'MB'); resolve(outputPath); } else reject(new Error('Normalize failed (code '+code+')')); });
    ff.on('error', reject);
  });
}

async function resolveVideo(videoUrl) {
  const url = videoUrl.trim(); if (!url) return null;
  let videoPath;
  if (isYouTubeUrl(url)) {
    const hash = require('crypto').createHash('md5').update(url).digest('hex').slice(0,12);
    videoPath = path.join(VIDEOS_DIR, 'yt_' + hash + '.mp4');
    if (!fs.existsSync(videoPath)) await downloadFromYouTube(url, videoPath);
    else log('YouTube cached: ' + videoPath);
  } else {
    const fid = extractDriveFileId(url);
    if (fid) {
      videoPath = path.join(VIDEOS_DIR, fid + '.mp4');
      // Clean corrupted cache (HTML files from failed downloads)
      if (fs.existsSync(videoPath)) {
        const sz = fs.statSync(videoPath).size;
        if (sz < 5000000) { try { const c = fs.readFileSync(videoPath, 'utf8'); if (c.includes('</html>')) { log('Cleaning corrupted cache: ' + videoPath); fs.unlinkSync(videoPath); } } catch(e) {} }
      }
      if (!fs.existsSync(videoPath)) await downloadFromDrive(fid, videoPath);
      else log('Drive cached: ' + videoPath);
    } else if (url.startsWith('http')) {
      videoPath = path.join(VIDEOS_DIR, uuidv4() + '.mp4');
      await downloadFromDrive(url, videoPath);
    } else return null;
  }
  return videoPath;
}

async function resolveAllVideos(urls, forPlaylist, useOverlay, autoSubs) {
  const paths = [];
  for (let i = 0; i < urls.length; i++) {
    log('Video ' + (i+1) + '/' + urls.length + ': ' + urls[i].substring(0,80) + '...');
    let vp = await resolveVideo(urls[i]);
    if (!vp) throw new Error('Invalid URL: ' + urls[i]);
    try { execSync('ffprobe -v quiet -print_format json -show_format "' + vp + '"'); } catch(e) { throw new Error('Not a valid video: ' + urls[i]); }
    if (autoSubs && i === 0 && GROQ_API_KEY) { await transcribeVideo(vp); }
    if ((forPlaylist && urls.length > 1) || (useOverlay && OVERLAY_NAME)) { vp = await normalizeVideo(vp, useOverlay); }
    paths.push(vp);
  }
  return paths;
}

function writeConcatFile(videoPaths) { const p = path.join(VIDEOS_DIR, 'current_playlist.txt'); fs.writeFileSync(p, videoPaths.map(v => "file '" + v + "'").join('\n')); return p; }

function startFFmpegConcat(concatFile, rtmpUrl, loop) {
  const la = loop ? ['-stream_loop', '-1'] : [];
  return spawn('ffmpeg', [...la, '-re', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-f', 'flv', rtmpUrl]);
}

function startSingleFFmpeg(videoPath, rtmpUrl, loop, useOverlay) {
  const info = getVideoInfo(videoPath);
  if (videoPath.includes('norm_')) { const la = loop ? ['-stream_loop', '-1'] : []; return spawn('ffmpeg', [...la, '-re', '-i', videoPath, '-c', 'copy', '-f', 'flv', rtmpUrl]); }
  const la = loop ? ['-stream_loop', '-1'] : [];
  const overlay = (useOverlay && info && info.width > info.height) ? getOverlayFilters() : null;
  if (info && info.width > info.height) {
    let filter = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
    const inputs = [...la, '-re', '-i', videoPath];
    if (overlay) { filter += ',' + overlay.filters.join(','); if (overlay.hasLogo) { inputs.push('-i', OVERLAY_LOGO_PATH); filter += '[prelogo];[1:v]scale=200:-1[logo];[prelogo][logo]overlay=W-w-40:H*0.177:format=auto'; } }
    return spawn('ffmpeg', [...inputs, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'fast', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmpUrl]);
  }
  return spawn('ffmpeg', [...la, '-re', '-i', videoPath, '-c:v', 'libx264', '-preset', 'fast', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmpUrl]);
}

function attachFFmpegHandlers(ffmpeg) {
  ffmpeg.stderr.on('data', (data) => { const line = data.toString().trim(); if (line.includes('Error') || line.includes('error') || line.includes('Stream mapping') || line.includes('Output #') || line.includes('frame=') && Math.random() < 0.02) { log('[ffmpeg] ' + line.substring(0, 200)); } });
  ffmpeg.on('close', (code) => { log('Stream ended (code ' + code + ')'); currentStream = null; });
  ffmpeg.on('error', (err) => { log('Stream error: ' + err.message); currentStream = null; });
}

app.get('/api/defaults', auth, (req, res) => { res.json({ streamUrl: DEFAULT_STREAM_URL, streamKey: DEFAULT_STREAM_KEY, account: DEFAULT_ACCOUNT }); });
app.get('/api/overlay', auth, (req, res) => { res.json({ name: OVERLAY_NAME, destinations: OVERLAY_DESTINATIONS, cta: OVERLAY_CTA, logoReady: fs.existsSync(OVERLAY_LOGO_PATH), active: !!OVERLAY_NAME && overlayReady, whisperReady: !!GROQ_API_KEY }); });

app.post('/api/stream/start', auth, async (req, res) => {
  if (currentStream) return res.status(400).json({ error: 'Stream already running. Stop it first.' });
  const { streamUrl, streamKey, videoUrl, videoUrls, loop, useOverlay, topTitle, autoSubs } = req.body;
  if (!streamKey) return res.status(400).json({ error: 'streamKey is required.' });
  let urls = [];
  if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim());
  else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'At least one video URL is required.' });
  try {
    currentTopTitle = (topTitle || '').trim();
    log('Preparing ' + urls.length + ' video(s)...' + (useOverlay && OVERLAY_NAME ? ' overlay: ' + OVERLAY_NAME : '') + (currentTopTitle ? ' title: ' + currentTopTitle : '') + (autoSubs ? ' auto-subs: on' : ''));
    const videoPaths = await resolveAllVideos(urls, true, !!useOverlay, !!autoSubs);
    const baseUrl = streamUrl && streamUrl.trim() ? streamUrl.trim().replace(/\/$/,'') : 'rtmps://live-upload.instagram.com:443/rtmp';
    const rtmpUrl = baseUrl + '/' + streamKey;
    let ffmpeg, concatFile = null;
    if (videoPaths.length === 1) { ffmpeg = startSingleFFmpeg(videoPaths[0], rtmpUrl, !!loop, !!useOverlay); }
    else { concatFile = writeConcatFile(videoPaths); ffmpeg = startFFmpegConcat(concatFile, rtmpUrl, !!loop); }
    log('Stream starting | Loop: ' + (loop?'yes':'no') + ' | Overlay: ' + (useOverlay && OVERLAY_NAME ? OVERLAY_NAME : 'off'));
    const streamId = uuidv4().slice(0, 8);
    currentStream = { id: streamId, process: ffmpeg, startedAt: new Date().toISOString(), videoUrls: urls, videoPaths, loop: !!loop, useOverlay: !!useOverlay, rtmpUrl, concatFile, streamUrl: baseUrl, streamKey };
    attachFFmpegHandlers(ffmpeg);
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (currentStream) { res.json({ success: true, streamId, videos: urls.length, overlay: (useOverlay && OVERLAY_NAME) ? OVERLAY_NAME : 'off', message: 'Stream started!' }); }
    else { res.status(500).json({ error: 'Stream failed. Check logs.' }); }
  } catch (err) { log('Error: ' + err.message); currentStream = null; res.status(500).json({ error: err.message }); }
});

app.post('/api/stream/swap', auth, async (req, res) => {
  if (!currentStream) return res.status(400).json({ error: 'No stream running.' });
  const { videoUrl, videoUrls } = req.body;
  let urls = []; if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim()); else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'Video URL required.' });
  try { const np = await resolveAllVideos(urls, true, currentStream.useOverlay, false); if (currentStream.concatFile) { fs.writeFileSync(currentStream.concatFile, np.map(p => "file '"+p+"'").join('\n')); currentStream.videoUrls = urls; currentStream.videoPaths = np; res.json({ success: true, message: 'Playlist updated.' }); } else { await doImmediateSwap(urls, np); res.json({ success: true, message: 'Video swapped!' }); } }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stream/swap-now', auth, async (req, res) => {
  if (!currentStream) return res.status(400).json({ error: 'No stream running.' });
  const { videoUrl, videoUrls } = req.body;
  let urls = []; if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) urls = videoUrls.filter(u => u && u.trim()); else if (videoUrl) urls = [videoUrl];
  if (urls.length === 0) return res.status(400).json({ error: 'Video URL required.' });
  try { const np = await resolveAllVideos(urls, true, currentStream.useOverlay, false); await doImmediateSwap(urls, np); res.json({ success: true, message: 'Video swapped!' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

async function doImmediateSwap(urls, newPaths) {
  const { rtmpUrl, loop } = currentStream;
  currentStream.process.removeAllListeners('close'); currentStream.process.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  let ffmpeg, concatFile = null;
  if (newPaths.length === 1) { ffmpeg = startSingleFFmpeg(newPaths[0], rtmpUrl, loop, currentStream.useOverlay); }
  else { concatFile = writeConcatFile(newPaths); ffmpeg = startFFmpegConcat(concatFile, rtmpUrl, loop); }
  currentStream.process = ffmpeg; currentStream.videoUrls = urls; currentStream.videoPaths = newPaths; currentStream.concatFile = concatFile;
  attachFFmpegHandlers(ffmpeg); await new Promise(r => setTimeout(r, 3000));
  if (currentStream) log('Swap: reconnected!'); else throw new Error('Reconnect failed.');
}

app.post('/api/stream/stop', auth, (req, res) => {
  if (!currentStream) return res.json({ message: 'No stream running.' });
  currentStream.process.kill('SIGTERM');
  setTimeout(() => { if (currentStream) { currentStream.process.kill('SIGKILL'); currentStream = null; } }, 5000);
  res.json({ success: true, message: 'Stream stopped.' });
});

app.get('/api/stream/status', auth, (req, res) => {
  if (!currentStream) return res.json({ streaming: false });
  res.json({ streaming: true, id: currentStream.id, startedAt: currentStream.startedAt, videoUrls: currentStream.videoUrls, loop: currentStream.loop, overlay: OVERLAY_NAME || 'off', uptime: Math.round((Date.now() - new Date(currentStream.startedAt).getTime()) / 1000) });
});

app.get('/api/logs', auth, (req, res) => { res.json({ logs: streamLogs.slice(-100) }); });

app.post('/api/cache/clear', auth, (req, res) => {
  const files = fs.readdirSync(VIDEOS_DIR); let removed = 0;
  files.forEach(f => { if (f === 'overlay_logo.png') return; fs.unlinkSync(path.join(VIDEOS_DIR, f)); removed++; });
  res.json({ success: true, removed });
});

app.post('/api/subtitles', auth, (req, res) => {
  const { srt } = req.body;
  if (!srt || !srt.trim()) { if (fs.existsSync(SUBTITLE_PATH)) fs.unlinkSync(SUBTITLE_PATH); return res.json({ success: true, message: 'Subtitles removed.' }); }
  fs.writeFileSync(SUBTITLE_PATH, srt.trim());
  res.json({ success: true, message: 'Subtitles saved.' });
});

app.get('/health', (req, res) => { res.json({ status: 'ok', streaming: !!currentStream, overlay: OVERLAY_NAME || 'off' }); });

(async () => {
  if (OVERLAY_NAME) { overlayReady = await downloadOverlayLogo(); log('Overlay: "' + OVERLAY_NAME + '" | Logo: ' + (overlayReady ? 'ready' : 'text-only')); } else { overlayReady = false; }
  app.listen(PORT, () => { log('LC LiveStream on port ' + PORT); if (OVERLAY_NAME) log('Overlay: ' + OVERLAY_NAME); if (GROQ_API_KEY) log('Whisper: ready'); });
})();
