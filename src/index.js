import { DurableObject } from "cloudflare:workers";

// ---- 初期値（運営画面からあとで編集できます） ----------------------------
const DEFAULT_HOW = [
  "作り直しの", "手を止めない", "沼に潜った", "逆算する",
  "一点突破の", "聞きまくる", "静かに燃える", "ひらめきが降る",
];
const DEFAULT_BEING = [
  "求道者", "発明家", "職人", "開拓者",
  "語り部", "実験者", "遊撃手", "巻き込み屋",
];
const DEFAULT_SPEAKERS = [
  { name: "田中 みなと", campus: "東京火曜クラス", product: "プロダクト名がはいります" },
  { name: "佐藤 りく", campus: "福岡土曜クラス", product: "プロダクト名がはいります" },
  { name: "鈴木 あおい", campus: "福岡土曜クラス", product: "プロダクト名がはいります" },
  { name: "高橋 そら", campus: "東京水金クラス", product: "プロダクト名がはいります" },
  { name: "伊藤 かえで", campus: "東京土曜クラス", product: "プロダクト名がはいります" },
];

const newId = () => crypto.randomUUID().slice(0, 8);

function defaultState() {
  return {
    speakers: DEFAULT_SPEAKERS.map((s) => ({ id: newId(), photo: "", ...s })),
    how: [...DEFAULT_HOW],
    being: [...DEFAULT_BEING],
    index: 0,
    phase: "voting", // voting | closed | revealed
    titles: {}, // speakerId -> { h, b }
    revealSeq: 0, // 称号表示のたびに増える（表示画面の演出トリガー）
    rev: 0,
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (v, max = 120) => String(v ?? "").trim().slice(0, max);

// ---- Durable Object：会場ひとつ分の状態と票をまとめて持つ ----------------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // "ping" には DO を起こさずに "pong" を返す（無料枠節約）
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async getState() {
    let s = await this.ctx.storage.get("state");
    if (!s) {
      s = defaultState();
      await this.ctx.storage.put("state", s);
    }
    return s;
  }

  async commit(s) {
    s.rev = (s.rev ?? 0) + 1;
    await this.ctx.storage.put("state", s);
    await this.broadcast(s);
    return s;
  }

  current(s) {
    return s.speakers[s.index] ?? null;
  }

  async tally(s) {
    const cur = this.current(s);
    const how = Array(s.how.length).fill(0);
    const being = Array(s.being.length).fill(0);
    let total = 0;
    if (cur) {
      const votes = await this.ctx.storage.list({ prefix: `vote:${cur.id}:` });
      for (const v of votes.values()) {
        if (how[v.h] !== undefined) how[v.h]++;
        if (being[v.b] !== undefined) being[v.b]++;
        total++;
      }
    }
    return { speakerId: cur?.id ?? null, how, being, total };
  }

  async broadcast(s) {
    const msg = JSON.stringify({ type: "state", state: s });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* 切断済み */ }
    }
    const admins = this.ctx.getWebSockets("admin");
    if (admins.length) {
      const t = JSON.stringify({ type: "tally", tally: await this.tally(s) });
      for (const ws of admins) {
        try { ws.send(t); } catch { /* 切断済み */ }
      }
    }
  }

  async fetch(request) {
    // WebSocket 接続（ワーカー側で役割と認証を済ませてから来る）
    const role = new URL(request.url).searchParams.get("role") === "admin" ? "admin" : "viewer";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    const s = await this.getState();
    server.send(JSON.stringify({ type: "state", state: s }));
    if (role === "admin") server.send(JSON.stringify({ type: "tally", tally: await this.tally(s) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() { /* クライアントからの送信は使わない */ }
  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch { /* noop */ }
  }

  // ---- 参加者向け ----
  async snapshot(voter) {
    const s = await this.getState();
    const cur = this.current(s);
    const mine = voter && cur ? (await this.ctx.storage.get(`vote:${cur.id}:${voter}`)) ?? null : null;
    return { state: s, mine };
  }

  async vote(voter, speakerId, h, b) {
    const s = await this.getState();
    const cur = this.current(s);
    if (!cur || cur.id !== speakerId) return { ok: false, error: "登壇者が切り替わりました。画面を確認してください" };
    if (s.phase !== "voting") return { ok: false, error: "締め切られました" };
    if (!Number.isInteger(h) || !Number.isInteger(b) || !s.how[h] || !s.being[b]) {
      return { ok: false, error: "選択が正しくありません" };
    }
    await this.ctx.storage.put(`vote:${cur.id}:${voter}`, { h, b });
    // 票が入ったら運営画面にだけ集計を送る（参加者には票数を見せない）
    const admins = this.ctx.getWebSockets("admin");
    if (admins.length) {
      const t = JSON.stringify({ type: "tally", tally: await this.tally(s) });
      for (const ws of admins) {
        try { ws.send(t); } catch { /* noop */ }
      }
    }
    return { ok: true, mine: { h, b } };
  }

  // ---- 運営向け ----
  async adminTally() {
    return this.tally(await this.getState());
  }

  async admin(action, p = {}) {
    const s = await this.getState();
    const last = s.speakers.length - 1;
    switch (action) {
      case "close":
        if (s.phase === "voting") s.phase = "closed";
        break;
      case "reopen":
        s.phase = "voting";
        break;
      case "reveal": {
        const cur = this.current(s);
        if (!cur || !s.how[p.h] || !s.being[p.b]) return { ok: false, error: "称号を選んでください" };
        s.titles[cur.id] = { h: p.h, b: p.b };
        s.phase = "revealed";
        s.revealSeq = (s.revealSeq ?? 0) + 1;
        break;
      }
      case "next":
        if (s.index < last) { s.index++; s.phase = "voting"; }
        break;
      case "prev":
        if (s.index > 0) { s.index--; s.phase = "voting"; }
        break;
      case "goto": {
        const i = Number(p.index);
        if (Number.isInteger(i) && i >= 0 && i <= last) { s.index = i; s.phase = "voting"; }
        break;
      }
      case "setPhoto": {
        const sp = s.speakers.find((x) => x.id === p.id);
        if (sp) sp.photo = clean(p.photo, 2000);
        break;
      }
      case "setSpeakers": {
        if (!Array.isArray(p.speakers) || !p.speakers.length) return { ok: false, error: "登壇者が空です" };
        const old = new Map(s.speakers.map((x) => [x.name, x]));
        s.speakers = p.speakers.slice(0, 200).map((x) => {
          const prev = old.get(clean(x.name, 60));
          return {
            id: prev?.id ?? newId(),
            name: clean(x.name, 60),
            campus: clean(x.campus, 60),
            product: clean(x.product, 120),
            photo: clean(x.photo, 2000) || prev?.photo || "",
          };
        }).filter((x) => x.name);
        s.index = Math.min(s.index, s.speakers.length - 1);
        s.phase = "voting";
        break;
      }
      case "shuffle": {
        const a = s.speakers;
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        s.index = 0;
        s.phase = "voting";
        break;
      }
      case "setVocab": {
        const how = (p.how ?? []).map((w) => clean(w, 20)).filter(Boolean);
        const being = (p.being ?? []).map((w) => clean(w, 20)).filter(Boolean);
        if (how.length < 2 || being.length < 2) return { ok: false, error: "語彙はそれぞれ2つ以上必要です" };
        s.how = how.slice(0, 16);
        s.being = being.slice(0, 16);
        // 語彙を変えると古い票・称号の意味が変わるので消す
        await this.ctx.storage.delete([...(await this.ctx.storage.list({ prefix: "vote:" })).keys()]);
        s.titles = {};
        s.phase = "voting";
        break;
      }
      case "resetVotes": {
        await this.ctx.storage.delete([...(await this.ctx.storage.list({ prefix: "vote:" })).keys()]);
        s.titles = {};
        s.index = 0;
        s.phase = "voting";
        break;
      }
      default:
        return { ok: false, error: "unknown action" };
    }
    await this.commit(s);
    return { ok: true };
  }
}

// ---- ワーカー：/api/* だけを処理し、それ以外は静的ファイル -------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const room = env.ROOM.get(env.ROOM.idFromName("main"));
    const pinOk = (pin) => Boolean(env.ADMIN_PIN) && pin === env.ADMIN_PIN;

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket only" }, 426);
      const role = url.searchParams.get("role");
      if (role === "admin" && !pinOk(url.searchParams.get("pin"))) return json({ error: "合言葉が違います" }, 401);
      return room.fetch(new Request(`https://room/ws?role=${role === "admin" ? "admin" : "viewer"}`, request));
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(await room.snapshot(clean(url.searchParams.get("voter"), 40)));
    }

    if (url.pathname === "/api/vote" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const voter = clean(body.voter, 40);
      if (!voter) return json({ ok: false, error: "voter missing" }, 400);
      const r = await room.vote(voter, clean(body.speakerId, 20), body.h, body.b);
      return json(r, r.ok ? 200 : 409);
    }

    if (url.pathname.startsWith("/api/admin")) {
      if (!env.ADMIN_PIN) return json({ ok: false, error: "ADMIN_PIN が未設定です（wrangler secret put ADMIN_PIN）" }, 500);
      if (!pinOk(request.headers.get("x-admin-pin"))) return json({ ok: false, error: "合言葉が違います" }, 401);
      if (url.pathname === "/api/admin/tally") return json(await room.adminTally());
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const r = await room.admin(clean(body.action, 30), body.payload ?? {});
        return json(r, r.ok ? 200 : 400);
      }
    }

    return json({ error: "not found" }, 404);
  },
};
