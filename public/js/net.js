// Транспорт: WebSocket, а если не вышло — HTTP long-polling.
// После обрыва переподключается сам и сообщает об этом через onStatus.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.mode = null;
    this.ws = null;
    this.cid = null;
    this.ack = 0;
    this.sendChain = Promise.resolve();
    this.gen = 0;
    this.forcePoll = new URLSearchParams(location.search).get('transport') === 'poll';
  }

  async connect() {
    const gen = ++this.gen;
    this.onStatus('connecting');
    for (let attempt = 0; ; attempt++) {
      if (gen !== this.gen) return;
      try {
        if (!this.forcePoll && !this.wsFailed) {
          await this.openWS(gen);
        } else {
          await this.openPoll(gen);
        }
        this.onStatus('online', this.mode);
        return;
      } catch {
        if (this.mode === null && !this.forcePoll && !this.wsFailed) {
          // WebSocket не прошёл (прокси/туннель) — дальше работаем через polling
          this.wsFailed = true;
          continue;
        }
        this.onStatus('offline');
        await sleep(Math.min(8000, 800 * 2 ** attempt));
      }
    }
  }

  openWS(gen) {
    return new Promise((resolve, reject) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }
      let opened = false;
      const to = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error('timeout'));
        }
      }, 10000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(to);
        this.ws = ws;
        this.mode = 'ws';
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(to);
          reject(new Error('ws error'));
        }
      };
      ws.onmessage = (e) => {
        try {
          this.onMessage(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!opened || gen !== this.gen) return;
        this.ws = null;
        this.connect();
      };
    });
  }

  async openPoll(gen) {
    const r = await fetch('/api/connect', { method: 'POST', cache: 'no-store' });
    if (!r.ok) throw new Error('connect failed');
    const { cid } = await r.json();
    this.cid = cid;
    this.ack = 0;
    this.mode = 'poll';
    this.onMessage({ t: 'hello', cid });
    this.pollLoop(gen, cid);
  }

  async pollLoop(gen, cid) {
    let fails = 0;
    while (gen === this.gen && this.cid === cid) {
      try {
        const r = await fetch(`/api/poll?cid=${cid}&ack=${this.ack}`, { cache: 'no-store' });
        if (r.status === 410) throw new Error('gone');
        if (!r.ok) throw new Error('poll ' + r.status);
        const { msgs } = await r.json();
        fails = 0;
        for (const { seq, msg } of msgs) {
          if (seq <= this.ack) continue;
          this.ack = seq;
          try {
            this.onMessage(msg);
          } catch (e) {
            console.error(e);
          }
        }
      } catch (e) {
        fails++;
        if (e.message === 'gone' || fails > 4) {
          if (gen === this.gen) {
            this.cid = null;
            this.connect();
          }
          return;
        }
        await sleep(1000 * fails);
      }
    }
  }

  send(m) {
    if (this.mode === 'ws' && this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(m));
      return;
    }
    if (this.mode === 'poll' && this.cid) {
      const cid = this.cid;
      this.sendChain = this.sendChain
        .then(() =>
          fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cid, m }),
          }),
        )
        .catch(() => {});
    }
  }
}
