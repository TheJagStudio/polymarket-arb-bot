import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import type { DiscoveredMarket } from "../gamma/markets.js";

/** Live best-bid/ask snapshot for a single token. */
export interface BookSide {
  bestBid: number | null;
  bestAsk: number | null;
  updatedAt: number;
}

/** Emitted whenever a market's book changes. The detector listens. */
export interface BookUpdate {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  windowMinutes: number;
  endDateIso: string;
  yes: BookSide;
  no: BookSide;
}

interface BookEvent {
  asset_id: string;
  market: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

interface PriceChangeEvent {
  market: string;
  price_changes: Array<{
    asset_id: string;
    side: "BUY" | "SELL";
    price: string;
    size: string;
    best_bid: string;
    best_ask: string;
  }>;
  timestamp: string;
}

// Polymarket's market WS doesn't include an `event_type` discriminator on
// most messages — events are identified by the presence of `bids`/`asks`
// (book snapshot) or `price_changes` (delta).
type WsEvent = Partial<BookEvent & PriceChangeEvent>;

const PING_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * MarketWs connects to Polymarket's market WebSocket, subscribes to a set of
 * token IDs, and emits a `book` event with the latest best-bid/ask for both
 * legs of a market whenever either leg moves.
 *
 *   const ws = new MarketWs(markets);
 *   ws.on("book", (update: BookUpdate) => detector.evaluate(update));
 *   ws.start();
 */
export class MarketWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  /** Per-token snapshot (best bid, best ask, last update). */
  private books = new Map<string, BookSide>();

  /** token_id → market metadata so we can emit pair updates. */
  private tokenToMarket = new Map<string, DiscoveredMarket>();

  /** asset_ids list sent on (re)subscribe. */
  private assetIds: string[];

  constructor(private markets: DiscoveredMarket[]) {
    super();
    this.assetIds = [];
    for (const m of markets) {
      this.tokenToMarket.set(m.yesTokenId, m);
      this.tokenToMarket.set(m.noTokenId, m);
      this.assetIds.push(m.yesTokenId, m.noTokenId);
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const cfg = getConfig();
    logger.info({ url: cfg.MARKET_WS_URL, tokens: this.assetIds.length }, "Connecting market WS");
    this.ws = new WebSocket(cfg.MARKET_WS_URL);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      const sub = {
        assets_ids: this.assetIds,
        type: "market",
        initial_dump: true,
        level: 2,
      };
      this.ws?.send(JSON.stringify(sub));
      logger.info({ assets: this.assetIds.length }, "Subscribed to market channel");

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
      }, PING_INTERVAL_MS);
    });

    let msgCount = 0;
    this.ws.on("message", (data) => {
      const text = data.toString();
      if (text === "PONG") return;
      msgCount++;
      if (msgCount <= 3) {
        logger.info({ msgPreview: text.slice(0, 300) }, "WS message sample");
      }
      try {
        // Polymarket sometimes batches events as a JSON array.
        const parsed = JSON.parse(text);
        const events: WsEvent[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const ev of events) this.handleEvent(ev);
      } catch (e) {
        logger.warn({ text: text.slice(0, 200) }, "Could not parse WS message");
      }
    });

    this.ws.on("error", (err) => {
      logger.error({ err: err.message }, "WS error");
    });

    this.ws.on("close", (code, reason) => {
      this.clearPing();
      if (this.stopped) return;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      );
      this.reconnectAttempts++;
      logger.warn({ code, reason: reason.toString(), delay }, "WS closed, reconnecting");
      setTimeout(() => this.connect(), delay);
    });
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleEvent(ev: WsEvent): void {
    if (ev.bids !== undefined && ev.asks !== undefined && ev.asset_id) {
      // Book snapshot.
      const bestBid = ev.bids.length > 0 ? Math.max(...ev.bids.map((b) => Number(b.price))) : null;
      const bestAsk = ev.asks.length > 0 ? Math.min(...ev.asks.map((a) => Number(a.price))) : null;
      this.updateBook(ev.asset_id, bestBid, bestAsk);
    } else if (ev.price_changes !== undefined) {
      // Delta — best_bid/best_ask are already aggregated by the server.
      for (const c of ev.price_changes) {
        const bestBid = c.best_bid && c.best_bid !== "" ? Number(c.best_bid) : null;
        const bestAsk = c.best_ask && c.best_ask !== "" ? Number(c.best_ask) : null;
        this.updateBook(c.asset_id, bestBid, bestAsk);
      }
    }
    // last_trade_price + others: ignored for now.
  }

  private updateBook(tokenId: string, bestBid: number | null, bestAsk: number | null): void {
    const market = this.tokenToMarket.get(tokenId);
    if (!market) return;

    this.books.set(tokenId, { bestBid, bestAsk, updatedAt: Date.now() });

    const yes = this.books.get(market.yesTokenId);
    const no = this.books.get(market.noTokenId);
    if (!yes || !no) return; // Wait until we've seen both legs at least once.

    const update: BookUpdate = {
      conditionId: market.conditionId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      windowMinutes: market.windowMinutes,
      endDateIso: market.endDateIso,
      yes,
      no,
    };
    this.emit("book", update);
  }
}
