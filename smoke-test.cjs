// Run: PUPPETEER_PATH=/path/to/puppeteer CHROME_PATH=/path/to/chrome node smoke-test.cjs [base-url]
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:8766/';
(async () => {
  const browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH, headless:true, args:['--disable-gpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  async function page() {
    const context = await browser.createBrowserContext();
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
    await p.setViewport({width:1440,height:1000}); await p.goto(base); await p.waitForSelector('.piece');
    return p;
  }
  const move = async (p, from, to) => { await p.click(`[data-square="${from}"]`); await p.click(`[data-square="${to}"]`); };
  try {
    const p = await page();
    assert.equal(await p.$$eval('.piece', els => els.length),32);
    assert.equal(await p.$eval('[data-square="7"]', e => e.classList.contains('light')),true);
    await p.click('[data-level="easy"]');
    await p.focus('[data-square="12"]'); await p.keyboard.press('Enter'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter');
    await p.waitForFunction(() => document.querySelector('#board').getAttribute('aria-busy') === 'false' && document.querySelector('#history').textContent.includes('e5'));
    const journal = await p.$eval('#history', e => e.textContent);
    await p.reload(); await p.waitForSelector('.piece'); assert.equal(await p.$eval('#history',e=>e.textContent),journal);
    await p.click('#undo'); assert.equal(await p.$$eval('.move-row',e=>e.length),0);
    for (const width of [390,320]) { await p.setViewport({width,height:844,isMobile:true,hasTouch:true}); assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true); }
    await p.evaluate(()=>navigator.serviceWorker.ready); await p.reload(); await p.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
    await p.setOfflineMode(true); await p.reload(); await p.waitForSelector('.piece'); await move(p,12,28);
    await p.waitForFunction(()=>document.querySelector('#history').textContent.includes('e5'));
    console.log('PASS computer, keyboard, undo, restore, mobile, offline AI');
    await p.setOfflineMode(false);
    await p.evaluate(() => localStorage.setItem('quiet-chess-v1','not json'));
    await p.reload(); await p.waitForSelector('.piece');
    assert.match(await p.$eval('#notice',e=>e.textContent), /could not be restored/);
    await p.evaluate(() => localStorage.setItem('quiet-chess-v1', JSON.stringify({level:'easy',moves:[[8,24],[55,39],[24,32],[39,31],[32,40],[31,23],[40,49],[23,14]].map(([from,to])=>({from,to,promotion:''}))})));
    await p.reload(); await p.waitForSelector('.piece'); await move(p,49,56);
    await p.waitForSelector('#promotion[open]'); await p.click('#promotion [value="queen"]');
    await p.waitForFunction(()=>document.querySelector('[data-square="56"]').getAttribute('aria-label').includes('white queen'));
    await p.evaluate(() => localStorage.setItem('quiet-chess-v1', JSON.stringify({level:'easy',moves:[[13,21],[52,36],[14,30],[59,31]].map(([from,to])=>({from,to,promotion:''}))})));
    await p.reload(); await p.waitForSelector('.piece');
    assert.match(await p.$eval('#status',e=>e.textContent), /Checkmate/);
    await move(p,12,28); assert.equal(await p.$$eval('.move-row',e=>e.length),2);
    console.log('PASS corrupt save recovery, promotion, terminal game lock');
    const host = await page(); await host.click('#friend-mode'); await host.click('#create-room');
    await host.waitForFunction(()=>!document.querySelector('#invite-label').hidden,{timeout:35000});
    const invite = await host.$eval('#invite',e=>e.value);
    const guest = await page(); await guest.goto(invite);
    const synced = p => p.waitForFunction(()=>document.querySelector('#room-status').textContent.includes('boards synced'),{timeout:45000});
    await synced(host); await synced(guest);
    assert.equal(await guest.$eval('.square',e=>e.dataset.square),'7');
    await move(guest,52,36); assert.equal(await guest.$$eval('.move-row',e=>e.length),0);
    await move(host,12,28); await guest.waitForFunction(()=>document.querySelector('#history').textContent.includes('e4'));
    await synced(guest); await move(guest,52,36); await host.waitForFunction(()=>document.querySelector('#history').textContent.includes('e5'));
    assert.equal(await host.$eval('#history',e=>e.textContent),await guest.$eval('#history',e=>e.textContent));
    assert.equal(await host.$eval('#undo',e=>e.disabled),true);
    const before = await host.$eval('#history',e=>e.textContent);
    await guest.reload(); await synced(guest); await synced(host);
    assert.equal(await guest.$eval('#history',e=>e.textContent),before);
    await host.reload(); await synced(host); await synced(guest);
    assert.equal(await host.$eval('#history',e=>e.textContent),before);
    await Promise.all([host.reload(),guest.reload()]); await synced(host); await synced(guest);
    assert.equal(await guest.$eval('#history',e=>e.textContent),before);
    await host.click('#sync-room'); await synced(host); await synced(guest);
    // Simulate a missed persisted move: shorten the guest's history, then refresh.
    await guest.evaluate(()=>{const id=new URLSearchParams(location.hash.slice(1)).get('room');const key='quiet-chess-room-v1:'+id;const s=JSON.parse(localStorage.getItem(key));s.moves.pop();localStorage.setItem(key,JSON.stringify(s));});
    await guest.goto('about:blank');
    await guest.goto(invite); await synced(guest); await synced(host);
    assert.equal(await guest.$eval('#history',e=>e.textContent),before);
    await move(host,6,21); await guest.waitForFunction(()=>document.querySelector('#history').textContent.includes('Nf3'));
    // A lost live update is recovered by the periodic state exchange, without reload.
    await synced(host); await synced(guest);
    await guest.evaluate(() => {
      const send = RTCDataChannel.prototype.send; let dropped = false;
      RTCDataChannel.prototype.send = function(data) {
        if (!dropped && typeof data === 'string' && data.includes('"type":"state"')) { dropped = true; return; }
        return send.call(this,data);
      };
    });
    await move(guest,57,42); await host.waitForFunction(()=>document.querySelector('#history').textContent.includes('Nc6'));
    assert.equal(await host.$eval('#history',e=>e.textContent),await guest.$eval('#history',e=>e.textContent));
    console.log('PASS dropped live update recovered without refresh');
    console.log('PASS guest/host/simultaneous refresh, same room, manual reconnect, stale-history recovery');
    // Divergent legal histories must not replace either player's saved game.
    const hostBeforeConflict = await host.$eval('#history',e=>e.textContent);
    await guest.evaluate(()=>{const id=new URLSearchParams(location.hash.slice(1)).get('room');const key='quiet-chess-room-v1:'+id;const s=JSON.parse(localStorage.getItem(key));s.moves=[{from:11,to:27,promotion:''}];localStorage.setItem(key,JSON.stringify(s));});
    await guest.reload();
    await host.waitForFunction(()=>document.querySelector('#room-status').textContent.includes('Sync conflict'),{timeout:45000});
    await guest.waitForFunction(()=>document.querySelector('#room-status').textContent.includes('Sync conflict'),{timeout:45000});
    assert.equal(await host.$eval('#history',e=>e.textContent),hostBeforeConflict);
    assert.match(await guest.$eval('#history',e=>e.textContent),/d4/);
    console.log('PASS conflict preserves both histories and pauses play');
    await guest.close(); await host.waitForFunction(()=>document.querySelector('#room-status').textContent.includes('disconnected'));
    console.log('PASS real PeerJS signaling, two contexts, board flip, turn gating, move sync, disconnect');
    assert.deepEqual(errors,[]); console.log('PASS no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
