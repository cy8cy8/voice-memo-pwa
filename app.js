// IndexedDB
let _db;
const dbOpen = () => _db ? Promise.resolve(_db) : new Promise((res, rej) => {
    const r = indexedDB.open('VoiceMemoApp', 1);
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
        _db = r.result;
        res(_db);
    };
    r.onupgradeneeded = e => e.target.result.createObjectStore('memos', {
        keyPath: 'id', autoIncrement: true
    });
});

const _s = m => _db.transaction('memos', m).objectStore('memos');
const _idb = r => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
})
const dbSave = m => _idb(_s('readwrite').add(m));
// const dbGet = id => _idb(_s().get(id));
const dbDelete = id => _idb(_s('readwrite').delete(id));
const dbGetAll = async () => (await _idb(_s().getAll())).reverse();

// State
let mediaRecorder, audioChunks = [], recordStart, timerRaf;
let isRecording = false, playback = null, memos = [];

// DOM
const $recordBtn = document.getElementById('recordBtn');
const $timer = document.getElementById('timer');
const $list = document.getElementById('memosList');
const $count = document.getElementById('memoCount');

// Boot
const init = async () => {
    await dbOpen();
    memos = await dbGetAll();
    renderList();
    $recordBtn.addEventListener('click', toggleRecording);
    window.addEventListener('beforeunload', () => isRecording && stopRecording(true));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
};

// Recording
const toggleRecording = () => isRecording ? stopRecording() : startRecording();

const startRecording = async () => {
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
            }
        });
    } catch(e) {
        alert(e.name === 'NotAllowedError' ? 'Mic access denied - enable it in your browser settings.' : `Could not access mic: ${e.message}`);
        return;
    }

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    mediaRecorder = new MediaRecorder(stream, mime ? {mimeType: mime, audioBitsPerSecond: 128000} : {audioBitsPerSecond: 128000});
    audioChunks = [];

    mediaRecorder.ondataavailable = e => e.data.size && audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        try {
            await saveRecording(new Blob(audioChunks, {type: mediaRecorder.mimeType}), mediaRecorder.mimeType);
        } catch(e) {
            alert("Failed to save recording - storage may be full");
        }
    };

    mediaRecorder.start(100);
    isRecording = true;
    recordStart = performance.now();
    $recordBtn.classList.add('recording');
    $recordBtn.textContent = 'STOP';
    $timer.classList.add('active');

    const tick = () => {
        $timer.textContent = fmt(Math.floor((performance.now() - recordStart) / 1000));
        timerRaf = requestAnimationFrame(tick);
    };
    timerRaf = requestAnimationFrame(tick);
};

const stopRecording = (discard = false) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    isRecording = false;
    cancelAnimationFrame(timerRaf);
    discard ? mediaRecorder.stream?.getTracks().forEach(t => t.stop()) : mediaRecorder.stop();
    $recordBtn.classList.remove('recording');
    $recordBtn.textContent = 'REC';
    $timer.classList.remove('active');
    $timer.textContent = '0:00';
};

// Save
const saveRecording = async (blob, mimeType) => {
    const now = new Date();
    const memo = {
        title: now.toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }),
        audio: blob,
    };
    memo.id = await dbSave(memo);
    memos.unshift(memo);
    renderList();
}

// Render
const renderList = () => {
    const n = memos.length;
    $count.textContent = `${n} memo${n !== 1 ? 's' : ''}`;
    $list.innerHTML = memos.map(memoCard).join('');
    memos.forEach(bindCard);
};

const memoCard = ({id, title}) => `
<div class="memo-card" id="card-${id}">
    <span class="memo-title">${esc(title)}</span>
    <div class="memo-footer">
        <button class="play-btn" aria-label="Play">
            <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
            <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="delete-btn" aria-label="Delete">🗑️</button>
    </div>
</div>
`;

const bindCard = m => {
    const card = document.getElementById(`card-${m.id}`);
    card.querySelector('.play-btn').addEventListener('click', () => togglePlay(m.id));
    card.querySelector('.delete-btn').addEventListener('click', () => doDelete(m.id));
};

// Playback
const togglePlay = id => {
    if (playback && playback.id !== id) stopPlayback();
    if (playback?.id === id) {
        playback.audio.paused ? (playback.audio.play(), setPlayUI(id, true)) : (playback.audio.pause(), setPlayUI(id, false));
        return;
    }
    const memo = memos.find(m => m.id === id);
    const url = URL.createObjectURL(memo.audio);
    const audio = new Audio(url);
    playback = {id, audio, url};
    setPlayUI(id, true);
    audio.addEventListener('ended', stopPlayback);
    audio.play();
};

const stopPlayback = () => {
    if (!playback) return;
    playback.audio.pause();
    URL.revokeObjectURL(playback.url);
    setPlayUI(playback.id, false);
    playback = null;
}

const setPlayUI = (id, on) => {
    const card = document.getElementById(`card-${id}`);
    if (!card) return;
    card.querySelector('.play-btn').classList.toggle('playing', on);
    card.querySelector('.icon-play').style.display = on ? 'none' : '';
    card.querySelector('.icon-pause').style.display = on ? '' : 'none';
};

// Delete
const doDelete = async id => {
    if (playback?.id === id) stopPlayback();
    await dbDelete(id);
    memos = memos.filter(m => m.id !== id);
    renderList();
};

// Helpers
const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const esc = s => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

init().catch(() => {
    document.body.innerHTML = '<p style="color:#ff4757;padding:24px">Storage unavailable. Voice Memo requires IndexedDB and cannot run in private browsing mode.</p>';
})