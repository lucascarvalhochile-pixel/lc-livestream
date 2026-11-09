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
const DATA_DIR = fs.existsSync('/data') ? '/data' : VIDEOS_DIR;
const OVERLAY_NAME = process.env.OVERLAY_NAME || '';
const OVERLAY_RAW_PATH = path.join(DATA_DIR, 'overlay_raw.img');
const OVERLAY_SCALED_PATH = path.join(DATA_DIR, 'overlay_scaled.png');
const OVERLAY_TOP_PATH = path.join(DATA_DIR, 'overlay_top.jpg');
const OVERLAY_BOT_PATH = path.join(DATA_DIR, 'overlay_bottom.jpg');
const SUBTITLE_PATH = path.join(VIDEOS_DIR, 'current_subtitles.srt');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const VIDEO_HISTORY_PATH = path.join(DATA_DIR, 'video_history.json');
const STREAM_DEFAULTS_PATH = path.join(DATA_DIR, 'stream_defaults.json');
let currentTopTitle = '';
// Default values; overridden by saved config from panel editor
let overlayTopH = 491, overlayBotY = 1174;

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Always clear band cache on startup to use current dimensions
try { fs.unlinkSync(OVERLAY_TOP_PATH); } catch(e) {}
try { fs.unlinkSync(OVERLAY_BOT_PATH); } catch(e) {}
try { fs.unlinkSync(OVERLAY_SCALED_PATH); } catch(e) {}

let savedDefaults = { streamUrl: '', streamKey: '', account: '', overlayUrl: '', overlayTopH: 0, overlayBotY: 0 };
function loadStreamDefaults() {
  try { if (fs.existsSync(STREAM_DEFAULTS_PATH)) {
    const d = JSON.parse(fs.readFileSync(STREAM_DEFAULTS_PATH, 'utf8'));
    savedDefaults = { streamUrl: d.streamUrl||'', streamKey: d.streamKey||'', account: d.account||'', overlayUrl: d.overlayUrl||'', overlayTopH: d.overlayTopH||0, overlayBotY: d.overlayBotY||0 };
    // Load user-defined crop values if set
    if (d.overlayTopH > 0 && d.overlayBotY > 0) { overlayTopH = d.overlayTopH; overlayBotY = d.overlayBotY; log('Overlay crop from config: topH=' + overlayTopH + ' botY=' + overlayBotY); }
    log('Defaults loaded from ' + DATA_DIR); return;
  } } catch(e) {}
  savedDefaults = { streamUrl: process.env.DEFAULT_STREAM_URL||'', streamKey: process.env.DEFAULT_STREAM_KEY||'', account: process.env.DEFAULT_ACCOUNT||'', overlayUrl: process.env.OVERLAY_URL||'', overlayTopH: 0, overlayBotY: 0 };
}
function saveStreamDefaults(obj) {
  if (obj.streamUrl !== undefined) savedDefaults.streamUrl = obj.streamUrl;
  if (obj.streamKey !== undefined) savedDefaults.streamKey = obj.streamKey;
  if (obj.account !== undefined) savedDefaults.account = obj.account;
  if (obj.overlayTopH !== undefined) savedDefaults.overlayTopH = obj.overlayTopH;
  if (obj.overlayBotY !== undefined) savedDefaults.overlayBotY = obj.overlayBotY;
  if (obj.overlayUrl !== undefined) {
    const oldUrl = savedDefaults.overlayUrl;
    savedDefaults.overlayUrl = obj.overlayUrl;
    if (obj.overlayUrl !== oldUrl) { try{fs.unlinkSync(OVERLAY_RAW_PATH);}catch(e){} try{fs.unlinkSync(OVERLAY_SCALED_PATH);}catch(e){} try{fs.unlinkSync(OVERLAY_TOP_PATH);}catch(e){} try{fs.unlinkSync(OVERLAY_BOT_PATH);}catch(e){} overlayReady = false; log('Overlay URL changed, cache cleared'); }
  }
  try { fs.writeFileSync(STREAM_DEFAULTS_PATH, JSON.stringify(savedDefaults, null, 2)); } catch(e) { log('Failed to save defaults: ' + e.message); }
}

let currentStream = null;
let streamLogs = [];
let overlayReady = false;
let videoHistory = [];
let isProcessing = false;
let streamProgress = { active: false, stage: '', globalPercent: 0, message: '' };
let _lastGlobalPct = 0;

function setProgress(stage, message, globalPercent) { if (globalPercent > _lastGlobalPct) _lastGlobalPct = globalPercent; streamProgress = { active: true, stage, globalPercent: _lastGlobalPct, message }; }
function resetProgress() { streamProgress = { active: false, stage: '', globalPercent: 0, message: '' }; _lastGlobalPct = 0; }
function loadVideoHistory() { try { if (fs.existsSync(VIDEO_HISTORY_PATH)) videoHistory = JSON.parse(fs.readFileSync(VIDEO_HISTORY_PATH, 'utf8')); } catch(e) { videoHistory = []; } }
function saveVideoHistory() { try { fs.writeFileSync(VIDEO_HISTORY_PATH, JSON.stringify(videoHistory, null, 2)); } catch(e) {} }
function getYouTubeId(url) { let m = url.match(/[?&]v=([^&]+)/); if (m) return m[1]; m = url.match(/youtu\.be\/([^?&]+)/); if (m) return m[1]; m = url.match(/\/embed\/([^?&]+)/); if (m) return m[1]; return null; }

function addToVideoHistory(url, videoPath) {
  try {
    const existing = videoHistory.findIndex(v => v.url === url);
    const stats = fs.statSync(videoPath); const info = getVideoInfo(videoPath);
    const sizeMB = Math.round(stats.size / 1024 / 1024);
    const orientation = info && info.width > info.height ? 'horizontal' : 'vertical';
    let source = 'url'; let label = ''; let thumbnail = '';
    if (isYouTubeUrl(url)) {
      source = 'youtube'; const ytId = getYouTubeId(url);
      if (ytId) thumbnail = 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg';
      try { label = execSync('yt-dlp --get-title --no-warnings "' + url + '"', { encoding: 'utf8', timeout: 15000 }).trim(); } catch(e) {}
      if (!label && ytId) label = 'YouTube ' + ytId;
    } else if (extractDriveFileId(url)) {
      source = 'drive'; const fid = extractDriveFileId(url);
      try { const html = execSync('curl -s -L "https://drive.google.com/file/d/' + fid + '/view" 2>/dev/null | head -c 5000', { encoding: 'utf8', timeout: 10000 }); const tm = html.match(/<title>([^<]+)<\/title>/i); if (tm && tm[1] && !tm[1].includes('Sign in')) label = tm[1].replace(' - Google Drive', '').replace(' - Google Docs', '').trim(); } catch(e) {}
      if (!label) label = 'Drive ' + fid.slice(0, 8) + '...';
    }
    if (!label) label = url.substring(0, 50);
    if (label.length > 80) label = label.substring(0, 77) + '...';
    const entry = { url, label, source, sizeMB, orientation, thumbnail, resolution: info ? info.width+'x'+info.height : '', lastUsed: new Date().toISOString() };
    if (existing >= 0) videoHistory[existing] = entry; else videoHistory.unshift(entry);
    if (videoHistory.length > 30) videoHistory = videoHistory.slice(0, 30);
    videoHistory.sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));
    saveVideoHistory();
  } catch(e) { log('History error: ' + e.message); }
}

function log(msg) { const entry = '[' + new Date().toISOString() + '] ' + msg; streamLogs.push(entry); if (streamLogs.length > 500) streamLogs.shift(); console.log(entry); }
function auth(req, res, next) { const key = req.headers['x-admin-key'] || req.query.key; if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' }); next(); }
function extractDriveFileId(url) { let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); if (m) return m[1]; m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m) return m[1]; return null; }
function isYouTubeUrl(url) { return /(?:youtube\.com|youtu\.be)/.test(url); }
function getVideoInfo(vp) { try { const r = execSync('ffprobe -v quiet -print_format json -show_streams -show_format "' + vp + '"', { encoding: 'utf8' }); const d = JSON.parse(r); const vs = d.streams.find(s => s.codec_type === 'video'); return vs ? { width: vs.width, height: vs.height } : null; } catch (e) { return null; } }

function downloadOverlayFromUrl(url) {
  const fid = extractDriveFileId(url); if (!fid) { log('Overlay URL: no Drive file ID'); return false; }
  log('Downloading overlay from Drive: ' + fid);
  const cj = path.join(VIDEOS_DIR, 'ovl_cookies.txt');
  try {
    execSync('curl -s -L -c "' + cj + '" -o "' + OVERLAY_RAW_PATH + '" "https://drive.usercontent.google.com/download?id=' + fid + '&export=download"', { timeout: 30000 });
    if (fs.statSync(OVERLAY_RAW_PATH).size < 50000) {
      try { const c = fs.readFileSync(OVERLAY_RAW_PATH, 'utf8'); if (c.includes('confirm=') || c.includes('</html>')) { const cm = c.match(/confirm=([a-zA-Z0-9_-]+)/); const ct = cm ? cm[1] : 't'; fs.unlinkSync(OVERLAY_RAW_PATH); execSync('curl -s -L -b "' + cj + '" -c "' + cj + '" -o "' + OVERLAY_RAW_PATH + '" "https://drive.usercontent.google.com/download?id=' + fid + '&export=download&confirm=' + ct + '"', { timeout: 60000 }); } } catch(e) {}
    }
    try { fs.unlinkSync(cj); } catch(e) {}
    const sz = fs.statSync(OVERLAY_RAW_PATH).size;
    if (sz < 10000) { log('Overlay too small: ' + sz + 'B'); try { fs.unlinkSync(OVERLAY_RAW_PATH); } catch(e) {} return false; }
    log('Overlay downloaded: ' + Math.round(sz / 1024) + 'KB');
    return true;
  } catch(e) { log('Overlay download error: ' + e.message); try { fs.unlinkSync(cj); } catch(ex) {} return false; }
}

function splitOverlayBands() {
  if (fs.existsSync(OVERLAY_TOP_PATH) && fs.existsSync(OVERLAY_BOT_PATH)) { log('Overlay bands: cached'); return true; }
  if (!fs.existsSync(OVERLAY_RAW_PATH)) return false;
  try {
    log('Splitting overlay (topH=' + overlayTopH + ', botY=' + overlayBotY + ')...');
    const info = getVideoInfo(OVERLAY_RAW_PATH);
    const origW = info ? info.width : 0;
    const origH = info ? info.height : 0;
    log('Overlay original: ' + origW + 'x' + origH);
    let srcPath = OVERLAY_RAW_PATH;
    if (origW !== 1080 || origH !== 1920) {
      execSync('ffmpeg -i "' + OVERLAY_RAW_PATH + '" -vf "scale=1080:1920:flags=lanczos" -y "' + OVERLAY_SCALED_PATH + '"', { timeout: 15000 });
      srcPath = OVERLAY_SCALED_PATH;
      log('Overlay scaled to 1080x1920');
    }
    execSync('ffmpeg -i "' + srcPath + '" -vf "crop=1080:' + overlayTopH + ':0:0" -update 1 -y "' + OVERLAY_TOP_PATH + '"', { timeout: 15000 });
    const botH = 1920 - overlayBotY;
    execSync('ffmpeg -i "' + srcPath + '" -vf "crop=1080:' + botH + ':0:' + overlayBotY + '" -update 1 -y "' + OVERLAY_BOT_PATH + '"', { timeout: 15000 });
    const ts = fs.statSync(OVERLAY_TOP_PATH).size;
    const bs = fs.statSync(OVERLAY_BOT_PATH).size;
    log('Bands ready: top ' + Math.round(ts/1024) + 'KB (h=' + overlayTopH + '), bottom ' + Math.round(bs/1024) + 'KB (h=' + botH + ' y=' + overlayBotY + ')');
    try { fs.unlinkSync(OVERLAY_SCALED_PATH); } catch(e) {}
    return ts > 1000 && bs > 1000;
  } catch(e) { log('Overlay split error: ' + e.message); return false; }
}

function setupOverlay() {
  if (!OVERLAY_NAME) { overlayReady = false; return; }
  if (fs.existsSync(OVERLAY_TOP_PATH) && fs.existsSync(OVERLAY_BOT_PATH)) { log('Overlay: ready (cached)'); overlayReady = true; return; }
  const ovlUrl = savedDefaults.overlayUrl || process.env.OVERLAY_URL || '';
  if (ovlUrl && !fs.existsSync(OVERLAY_RAW_PATH)) { downloadOverlayFromUrl(ovlUrl); }
  if (fs.existsSync(OVERLAY_RAW_PATH)) { overlayReady = splitOverlayBands(); if (overlayReady) return; }
  log('No overlay found'); overlayReady = false;
}

function downloadFromDrive(fileId, destPath) {
  return new Promise((resolve, reject) => {
    log('Downloading from Drive: ' + fileId); const cj = path.join(VIDEOS_DIR, 'gdrive_cookies.txt');
    try {
      execSync('curl -s -L -c "' + cj + '" -o "' + destPath + '" "https://drive.usercontent.google.com/download?id=' + fileId + '&export=download"', { timeout: 30000 });
      if (fs.statSync(destPath).size < 5000000) {
        const c = fs.readFileSync(destPath, 'utf8');
        if (c.includes('confirm=') || c.includes('virus') || c.includes('</html>')) {
          const cm = c.match(/confirm=([a-zA-Z0-9_-]+)/); const ct = cm ? cm[1] : 't'; fs.unlinkSync(destPath);
          execSync('curl -s -L -b "' + cj + '" -c "' + cj + '" -o "' + destPath + '" "https://drive.usercontent.google.com/download?id=' + fileId + '&export=download&confirm=' + ct + '"', { timeout: 600000, maxBuffer: 10*1024*1024 });
          if (fs.statSync(destPath).size < 5000000) { const c2 = fs.readFileSync(destPath, 'utf8'); if (c2.includes('</html>')) { fs.unlinkSync(destPath); execSync('curl -s -L -o "' + destPath + '" "https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&key=AIzaSyC1qbk75NzWBvSaDh6KnUvjbjV0y36XUY0"', { timeout: 600000 }); if (fs.statSync(destPath).size < 5000000) { fs.unlinkSync(destPath); reject(new Error('Drive download failed')); return; } } }
        }
      }
      try { fs.unlinkSync(cj); } catch(e) {}
      log('Download: ' + Math.round(fs.statSync(destPath).size/1024/1024) + 'MB');
      if (fs.statSync(destPath).size < 100000) { try { if (fs.readFileSync(destPath, 'utf8').includes('</html>')) { fs.unlinkSync(destPath); reject(new Error('Drive blocked')); return; } } catch(e) {} }
      resolve(destPath);
    } catch (e) { try{fs.unlinkSync(cj);}catch(ex){} try{fs.unlinkSync(destPath);}catch(ex){} reject(new Error('Drive: ' + e.message)); }
  });
}

function downloadFromYouTube(url, destPath) {
  return new Promise((resolve, reject) => {
    log('Downloading from YouTube: ' + url);
    const yt = spawn('yt-dlp', ['-f','bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best','--merge-output-format','mp4','-o',destPath,'--no-playlist','--no-warnings',url]);
    yt.stdout.on('data', (d) => { const l=d.toString().trim(); if(l.includes('%')){log('[yt-dlp] '+l); const p=l.match(/([\d.]+)%/); if(p) setProgress('downloading','YouTube: '+Math.round(parseFloat(p[1]))+'%', 5+Math.round(parseFloat(p[1])*0.75));} });
    yt.stderr.on('data', (d) => { const l=d.toString().trim(); if(l) log('[yt-dlp] '+l); });
    yt.on('close', (code) => { if(code===0&&fs.existsSync(destPath)){log('YouTube: '+Math.round(fs.statSync(destPath).size/1024/1024)+'MB');resolve(destPath);} else reject(new Error('yt-dlp failed')); });
    yt.on('error', reject);
  });
}

function transcribeVideo(videoPath) {
  return new Promise(async (resolve) => {
    if (!GROQ_API_KEY) { resolve(false); return; }
    const ap = path.join(VIDEOS_DIR, 'temp_audio.mp3');
    try {
      setProgress('transcribing', 'Extraindo audio...', 82);
      execSync('ffmpeg -i "' + videoPath + '" -vn -acodec libmp3lame -q:a 4 -y "' + ap + '"', { timeout: 120000 });
      if (fs.statSync(ap).size > 25*1024*1024) { execSync('ffmpeg -i "'+ap+'" -t 1500 -y "'+ap+'.tmp.mp3"', {timeout:60000}); fs.renameSync(ap+'.tmp.mp3', ap); }
      setProgress('transcribing', 'Gerando legendas...', 86);
      const r = execSync('curl -s -X POST "https://api.groq.com/openai/v1/audio/transcriptions" -H "Authorization: Bearer '+GROQ_API_KEY+'" -F "file=@'+ap+'" -F "model=whisper-large-v3" -F "response_format=srt" -F "language=pt"', { encoding:'utf8', timeout:300000, maxBuffer:50*1024*1024 });
      if (r && r.includes('-->')) { fs.writeFileSync(SUBTITLE_PATH, r.trim()); setProgress('transcribing','Legendas prontas!',90); resolve(true); }
      else { resolve(false); }
    } catch(e) { log('Transcription error: '+e.message); resolve(false); }
    finally { try{fs.unlinkSync(ap);}catch(e){} }
  });
}

function buildOverlayFilter(useOverlay) {
  let filter = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
  const inputs = []; let idx = 1;
  if (useOverlay && overlayReady && fs.existsSync(OVERLAY_TOP_PATH) && fs.existsSync(OVERLAY_BOT_PATH)) {
    inputs.push('-i', OVERLAY_TOP_PATH, '-i', OVERLAY_BOT_PATH);
    filter += '[base];[base][' + idx + ':v]overlay=0:0[t];[t][' + (idx+1) + ':v]overlay=0:' + overlayBotY;
    idx += 2;
  }
  if (currentTopTitle) {
    const esc = (t) => t.replace(/'/g, "'\\\\\\'''").replace(/:/g, '\\:');
    const titleY = Math.max(0, overlayTopH - 45);
    filter += ',drawbox=x=0:y=' + titleY + ':w=iw:h=40:color=black@0.5:t=fill';
    filter += ",drawtext=text='" + esc(currentTopTitle) + "':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=20:fontcolor=white:x=(w-text_w)/2:y=" + (titleY + 10);
  }
  if (fs.existsSync(SUBTITLE_PATH)) { filter += ",subtitles=" + SUBTITLE_PATH.replace(/:/g,'\\\\:') + ":force_style='FontSize=24,FontName=DejaVu Sans,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Alignment=2,MarginV=350'"; }
  return { filter, inputs };
}

function normalizeForPlaylist(ip) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('md5').update(ip+'playlist').digest('hex').slice(0,8);
    const out = path.join(VIDEOS_DIR, 'norm_'+hash+'.mp4');
    if (fs.existsSync(out)) { resolve(out); return; }
    const info = getVideoInfo(ip); if(!info){reject(new Error('Bad video'));return;}
    let filter; if(info.width>info.height){filter='[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30';} else {filter='scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=30';}
    const ff = spawn('ffmpeg',['-i',ip,'-filter_complex',filter,'-c:v','libx264','-preset','fast','-b:v','4500k','-maxrate','6000k','-bufsize','12000k','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-y',out]);
    let dur=0; try{dur=parseFloat(execSync('ffprobe -v quiet -show_entries format=duration -of csv=p=0 "'+ip+'"',{encoding:'utf8'}).trim())||0;}catch(e){}
    ff.stderr.on('data',(d)=>{const l=d.toString().trim();if(l.includes('frame=')&&dur>0){const tm=l.match(/time=(\d+):(\d+):(\d+\.\d+)/);if(tm){const s=parseInt(tm[1])*3600+parseInt(tm[2])*60+parseFloat(tm[3]);setProgress('normalizing','Processando: '+Math.min(99,Math.round(s/dur*100))+'%',40+Math.round(Math.min(99,s/dur*100)*0.45));}}});
    ff.on('close',(code)=>{if(code===0&&fs.existsSync(out))resolve(out);else reject(new Error('Normalize failed'));});
    ff.on('error',reject);
  });
}

async function resolveVideo(videoUrl) {
  const url = videoUrl.trim(); if(!url) return null; let vp;
  if (isYouTubeUrl(url)) {
    const hash = require('crypto').createHash('md5').update(url).digest('hex').slice(0,12);
    vp = path.join(VIDEOS_DIR, 'yt_'+hash+'.mp4');
    if (!fs.existsSync(vp)) { setProgress('downloading','Baixando do YouTube...',5); await downloadFromYouTube(url, vp); }
    else { log('YouTube cached'); setProgress('downloading','Video em cache!',80); }
  } else {
    const fid = extractDriveFileId(url);
    if (fid) {
      vp = path.join(VIDEOS_DIR, fid+'.mp4');
      if(fs.existsSync(vp)){const sz=fs.statSync(vp).size;if(sz<5000000){try{if(fs.readFileSync(vp,'utf8').includes('</html>'))fs.unlinkSync(vp);}catch(e){}}}
      if(!fs.existsSync(vp)){setProgress('downloading','Baixando do Google Drive...',5);await downloadFromDrive(fid,vp);setProgress('downloading','Download completo!',80);}
      else{log('Drive cached');setProgress('downloading','Video em cache!',80);}
    } else if(url.startsWith('http')){vp=path.join(VIDEOS_DIR,uuidv4()+'.mp4');await downloadFromDrive(url,vp);}
    else return null;
  }
  setTimeout(()=>addToVideoHistory(url,vp),100);
  return vp;
}

async function resolveAllVideos(urls, forPlaylist, autoSubs) {
  const paths = [];
  for (let i = 0; i < urls.length; i++) {
    setProgress('downloading','Baixando video '+(i+1)+'/'+urls.length+'...',Math.round(i*(80/urls.length))+2);
    let vp = await resolveVideo(urls[i]); if(!vp) throw new Error('Invalid URL: '+urls[i]);
    try{execSync('ffprobe -v quiet -print_format json -show_format "'+vp+'"');}catch(e){throw new Error('Not a valid video: '+urls[i]);}
    if(autoSubs && i===0 && GROQ_API_KEY) await transcribeVideo(vp);
    if(forPlaylist && urls.length > 1) vp = await normalizeForPlaylist(vp);
    paths.push(vp);
  }
  return paths;
}

function writeConcatFile(vp){const p=path.join(VIDEOS_DIR,'playlist.txt');fs.writeFileSync(p,vp.map(v=>"file '"+v+"'").join('\n'));return p;}
function startFFmpegConcat(cf,url,loop){return spawn('ffmpeg',[...(loop?['-stream_loop','-1']:[]),'-re','-f','concat','-safe','0','-i',cf,'-c','copy','-f','flv',url]);}

function startSingleFFmpeg(vp, rtmpUrl, loop, useOverlay) {
  const info = getVideoInfo(vp); const la = loop ? ['-stream_loop', '-1'] : [];
  if (info && info.width > info.height) {
    const { filter, inputs } = buildOverlayFilter(useOverlay);
    return spawn('ffmpeg', [...la, '-re', '-i', vp, ...inputs, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'fast', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmpUrl]);
  }
  return spawn('ffmpeg', [...la, '-re', '-i', vp, '-c:v', 'libx264', '-preset', 'fast', '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '12000k', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmpUrl]);
}

function attachFFmpegHandlers(ff) {
  ff.stderr.on('data',(d)=>{const l=d.toString().trim();if(l.includes('Error')||l.includes('error')||l.includes('Output #')||(l.includes('frame=')&&Math.random()<0.02))log('[ffmpeg] '+l.substring(0,200));});
  ff.on('close',(code)=>{log('Stream ended (code '+code+')');currentStream=null;});
  ff.on('error',(err)=>{log('Stream error: '+err.message);currentStream=null;});
}

// === API ENDPOINTS ===
app.get('/api/defaults',auth,(req,res)=>{res.json({streamUrl:savedDefaults.streamUrl,streamKey:savedDefaults.streamKey,account:savedDefaults.account,overlayUrl:savedDefaults.overlayUrl});});
app.post('/api/save-defaults',auth,(req,res)=>{saveStreamDefaults(req.body);res.json({success:true,message:'Saved.'});});
app.get('/api/overlay',auth,(req,res)=>{res.json({name:OVERLAY_NAME,pngReady:overlayReady,active:!!OVERLAY_NAME&&overlayReady,overlayUrl:savedDefaults.overlayUrl,whisperReady:!!GROQ_API_KEY});});
app.get('/api/progress',auth,(req,res)=>{res.json(streamProgress);});
app.get('/api/video-history',auth,(req,res)=>{res.json(videoHistory);});

// Overlay editor: serve overlay image for preview
app.get('/api/overlay-image',auth,(req,res)=>{
  if (!fs.existsSync(OVERLAY_RAW_PATH)) {
    // Try to download it
    const ovlUrl = savedDefaults.overlayUrl || process.env.OVERLAY_URL || '';
    if (ovlUrl) downloadOverlayFromUrl(ovlUrl);
  }
  if (!fs.existsSync(OVERLAY_RAW_PATH)) return res.status(404).json({error:'No overlay image'});
  res.sendFile(OVERLAY_RAW_PATH);
});

// Overlay editor: get/set crop config
app.get('/api/overlay-config',auth,(req,res)=>{
  res.json({ topH: overlayTopH, botY: overlayBotY, hasImage: fs.existsSync(OVERLAY_RAW_PATH) });
});
app.post('/api/overlay-config',auth,(req,res)=>{
  const { topH, botY } = req.body;
  if (!topH || !botY || topH < 50 || botY > 1870 || topH >= botY) return res.status(400).json({error:'Invalid values'});
  overlayTopH = Math.round(topH);
  overlayBotY = Math.round(botY);
  // Clear band cache so next stream uses new values
  try{fs.unlinkSync(OVERLAY_TOP_PATH);}catch(e){}
  try{fs.unlinkSync(OVERLAY_BOT_PATH);}catch(e){}
  overlayReady = false;
  // Save to defaults
  saveStreamDefaults({ overlayTopH, overlayBotY });
  // Regenerate bands immediately
  setupOverlay();
  log('Overlay config saved: topH=' + overlayTopH + ' botY=' + overlayBotY + ' ready=' + overlayReady);
  res.json({ success: true, topH: overlayTopH, botY: overlayBotY, ready: overlayReady });
});

app.post('/api/stream/start',auth,(req,res)=>{
  if(currentStream) return res.status(400).json({error:'Stream already running.'});
  if(isProcessing) return res.status(400).json({error:'Ja esta preparando.'});
  const{streamUrl,streamKey,videoUrl,videoUrls,loop,useOverlay,topTitle,autoSubs}=req.body;
  if(!streamKey) return res.status(400).json({error:'streamKey required.'});
  let urls=[]; if(videoUrls&&Array.isArray(videoUrls)&&videoUrls.length>0) urls=videoUrls.filter(u=>u&&u.trim()); else if(videoUrl) urls=[videoUrl];
  if(urls.length===0) return res.status(400).json({error:'Video URL required.'});
  saveStreamDefaults({streamUrl, streamKey});
  if (useOverlay && !overlayReady) setupOverlay();
  isProcessing=true; currentTopTitle=(topTitle||'').trim();
  resetProgress(); setProgress('downloading','Preparando '+urls.length+' video(s)...',1);
  log('Preparing '+urls.length+' video(s)...'+(useOverlay&&overlayReady?' overlay: '+overlayTopH+'/'+overlayBotY:'')+(currentTopTitle?' title: '+currentTopTitle:'')+(autoSubs?' auto-subs':''));
  res.json({success:true,status:'processing',message:'Preparando videos...'});
  (async()=>{
    try{
      const videoPaths=await resolveAllVideos(urls,true,!!autoSubs);
      setProgress('starting','Conectando...',92);
      const baseUrl=streamUrl&&streamUrl.trim()?streamUrl.trim().replace(/\/$/,''):'rtmps://live-upload.instagram.com:443/rtmp';
      const rtmpUrl=baseUrl+'/'+streamKey;
      let ffmpeg,cf=null;
      if(videoPaths.length===1) ffmpeg=startSingleFFmpeg(videoPaths[0],rtmpUrl,!!loop,!!useOverlay);
      else{cf=writeConcatFile(videoPaths);ffmpeg=startFFmpegConcat(cf,rtmpUrl,!!loop);}
      log('Stream starting | Overlay: '+(useOverlay&&overlayReady?'on ('+overlayTopH+'/'+overlayBotY+')':'off'));
      currentStream={id:uuidv4().slice(0,8),process:ffmpeg,startedAt:new Date().toISOString(),videoUrls:urls,videoPaths,loop:!!loop,useOverlay:!!useOverlay,rtmpUrl,concatFile:cf};
      attachFFmpegHandlers(ffmpeg);
      await new Promise(r=>setTimeout(r,3000));
      if(currentStream){setProgress('live','Ao vivo!',100);setTimeout(resetProgress,5000);}
      else resetProgress();
    }catch(err){log('Error: '+err.message);resetProgress();currentStream=null;}
    finally{isProcessing=false;}
  })();
});

app.post('/api/stream/swap',auth,async(req,res)=>{if(!currentStream)return res.status(400).json({error:'No stream.'});const{videoUrl,videoUrls}=req.body;let urls=[];if(videoUrls&&Array.isArray(videoUrls)&&videoUrls.length>0)urls=videoUrls.filter(u=>u&&u.trim());else if(videoUrl)urls=[videoUrl];if(urls.length===0)return res.status(400).json({error:'URL required.'});try{const np=await resolveAllVideos(urls,true,false);if(currentStream.concatFile){fs.writeFileSync(currentStream.concatFile,np.map(p=>"file '"+p+"'").join('\n'));currentStream.videoUrls=urls;currentStream.videoPaths=np;res.json({success:true,message:'Playlist updated.'});}else{await doSwap(urls,np);res.json({success:true,message:'Swapped!'}); }}catch(err){res.status(500).json({error:err.message});}});
app.post('/api/stream/swap-now',auth,async(req,res)=>{if(!currentStream)return res.status(400).json({error:'No stream.'});const{videoUrl,videoUrls}=req.body;let urls=[];if(videoUrls&&Array.isArray(videoUrls)&&videoUrls.length>0)urls=videoUrls.filter(u=>u&&u.trim());else if(videoUrl)urls=[videoUrl];if(urls.length===0)return res.status(400).json({error:'URL required.'});try{const np=await resolveAllVideos(urls,true,false);await doSwap(urls,np);res.json({success:true,message:'Swapped!'});}catch(err){res.status(500).json({error:err.message});}});

async function doSwap(urls,np){currentStream.process.removeAllListeners('close');currentStream.process.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));let ff,cf=null;if(np.length===1)ff=startSingleFFmpeg(np[0],currentStream.rtmpUrl,currentStream.loop,currentStream.useOverlay);else{cf=writeConcatFile(np);ff=startFFmpegConcat(cf,currentStream.rtmpUrl,currentStream.loop);}currentStream.process=ff;currentStream.videoUrls=urls;currentStream.videoPaths=np;currentStream.concatFile=cf;attachFFmpegHandlers(ff);await new Promise(r=>setTimeout(r,3000));if(currentStream)log('Swap OK');else throw new Error('Reconnect failed');}

app.post('/api/stream/stop',auth,(req,res)=>{if(!currentStream)return res.json({message:'No stream.'});currentStream.process.kill('SIGTERM');setTimeout(()=>{if(currentStream){currentStream.process.kill('SIGKILL');currentStream=null;}},5000);resetProgress();isProcessing=false;res.json({success:true,message:'Stopped.'});});
app.get('/api/stream/status',auth,(req,res)=>{if(!currentStream)return res.json({streaming:false,processing:isProcessing});res.json({streaming:true,processing:false,id:currentStream.id,startedAt:currentStream.startedAt,videoUrls:currentStream.videoUrls,loop:currentStream.loop,overlay:overlayReady?'on':'off',uptime:Math.round((Date.now()-new Date(currentStream.startedAt).getTime())/1000)});});
app.get('/api/logs',auth,(req,res)=>{res.json({logs:streamLogs.slice(-100)});});
app.post('/api/cache/clear',auth,(req,res)=>{const files=fs.readdirSync(VIDEOS_DIR);let rm=0;files.forEach(f=>{fs.unlinkSync(path.join(VIDEOS_DIR,f));rm++;});res.json({success:true,removed:rm});});
app.post('/api/subtitles',auth,(req,res)=>{const{srt}=req.body;if(!srt||!srt.trim()){if(fs.existsSync(SUBTITLE_PATH))fs.unlinkSync(SUBTITLE_PATH);return res.json({success:true,message:'Removed.'});}fs.writeFileSync(SUBTITLE_PATH,srt.trim());res.json({success:true,message:'Saved.'});});
app.get('/health',(req,res)=>{res.json({status:'ok',streaming:!!currentStream,processing:isProcessing,overlay:overlayReady?'on':'off',crop:overlayTopH+'/'+overlayBotY,dataDir:DATA_DIR});});

(()=>{
  loadVideoHistory();
  loadStreamDefaults();
  setupOverlay();
  app.listen(PORT,()=>{log('LC LiveStream on port '+PORT+' | data: '+DATA_DIR);log('Overlay crop: topH='+overlayTopH+' botY='+overlayBotY+(overlayReady?' READY':' not ready'));if(GROQ_API_KEY)log('Whisper: ready');log('History: '+videoHistory.length);});
})();
