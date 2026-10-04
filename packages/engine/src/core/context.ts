import type { ActionOutcome, CountryId, Reliability, WorldState } from "../state/types.js";
import { Rng, rngStream } from "./rng.js";

export type FactCategory = "action" | "domestic" | "economy" | "military" | "diplomacy" | "world" | "intelligence" | "territory";

/** A fact produced during resolution. Narration and reports are built from facts only. */
export interface TurnFact {
  category: FactCategory;
  text: string;
  actors: CountryId[];
  /** 1 minor, 2 notable, 3 major (major facts become history records). */
  importance: 1 | 2 | 3;
  /** If false, only actors (and those with intel) know about it. */
  public: boolean;
  causeId?: string;
  reliability?: Reliability;
  /** Only shown to this observer (e.g. intel reports). */
  audience?: CountryId;
}

export class TurnContext {
  facts: TurnFact[] = [];
  outcomes: ActionOutcome[] = [];
  territory: { province: string; from: CountryId; to: CountryId; kind: "control" | "ownership" }[] = [];
  private streams = new Map<string, Rng>();
  /** One-off fiscal flows this month (USD bn): aid sent, aid received, asset sales, etc. */
  extraSpending = new Map<CountryId, number>();
  extraRevenue = new Map<CountryId, number>();
  constructor(public state: WorldState) {}

  get turn() {
    return this.state.meta.turn;
  }

  rng(name: string): Rng {
    let r = this.streams.get(name);
    if (!r) {
      r = rngStream(this.state.meta.seed, this.state.meta.turn, name);
      this.streams.set(name, r);
    }
    return r;
  }

  addSpending(c: CountryId, bn: number) {
    this.extraSpending.set(c, (this.extraSpending.get(c) ?? 0) + bn);
  }

  addRevenue(c: CountryId, bn: number) {
    this.extraRevenue.set(c, (this.extraRevenue.get(c) ?? 0) + bn);
  }

  fact(f: Omit<TurnFact, "importance" | "public"> & Partial<Pick<TurnFact, "importance" | "public">>) {
    this.facts.push({ importance: 1, public: true, ...f });
  }
}

export function nextId(state: WorldState, prefix: string): string {
  state.meta.nextId += 1;
  return `${prefix}-${state.meta.nextId}`;
}
