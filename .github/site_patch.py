from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

for name in ('python', 'c', 'javascript', 'html', 'css', 'tg'):
    s = s.replace(f'/static/{name}.png', f'/static/{name}.webp')

s = s.replace('const FROZEN_VISITOR_COUNT = 276;', 'const FROZEN_VISITOR_COUNT = 312;')

old_apply = """            if (siteSettings.music.url && audio.src !== siteSettings.music.url) {
                audio.src = siteSettings.music.url;
            }
            if (audio.paused && siteSettings.music.autoplay) {
                playWithFade().catch(error => { console.log('Autoplay prevented'); });
            }"""
new_apply = """            if (siteSettings.music.url) {
                const configuredUrl = new URL(siteSettings.music.url, window.location.href).href;
                if (audio.src !== configuredUrl) audio.src = configuredUrl;
            }"""
if old_apply not in s:
    raise SystemExit('applySettings audio block not found')
s = s.replace(old_apply, new_apply, 1)

old_load = """    window.addEventListener('load', () => {
        if (siteSettings.music.enabled && siteSettings.music.autoplay && audio.paused) {
            playWithFade().catch(error => {
                console.log('Autoplay prevented');
                document.body.addEventListener('click', function initAudio() {
                    if (siteSettings.music.enabled) {
                        playWithFade().catch(() => {});
                    }
                    document.body.removeEventListener('click', initAudio);
                }, { once: true });
            });
        }
    });"""
new_load = """    let audioUnlockArmed = false;

    function removeAudioUnlockListeners() {
        if (!audioUnlockArmed) return;
        audioUnlockArmed = false;
        document.removeEventListener('pointerdown', unlockAudioFromGesture, true);
        document.removeEventListener('touchstart', unlockAudioFromGesture, true);
        document.removeEventListener('keydown', unlockAudioFromGesture, true);
    }

    function unlockAudioFromGesture() {
        if (!siteSettings.music.enabled || !audio.paused) {
            removeAudioUnlockListeners();
            return;
        }
        playWithFade()
            .then(removeAudioUnlockListeners)
            .catch(() => {});
    }

    function armAudioUnlock() {
        if (audioUnlockArmed || !siteSettings.music.enabled) return;
        audioUnlockArmed = true;
        document.addEventListener('pointerdown', unlockAudioFromGesture, true);
        document.addEventListener('touchstart', unlockAudioFromGesture, true);
        document.addEventListener('keydown', unlockAudioFromGesture, true);
    }

    armAudioUnlock();

    window.addEventListener('load', () => {
        if (siteSettings.music.enabled && siteSettings.music.autoplay && audio.paused) {
            playWithFade()
                .then(removeAudioUnlockListeners)
                .catch(() => {
                    console.log('Autoplay prevented; waiting for user interaction');
                    armAudioUnlock();
                });
        }
    });"""
if old_load not in s:
    raise SystemExit('window load audio block not found')
s = s.replace(old_load, new_load, 1)

p.write_text(s, encoding='utf-8')
