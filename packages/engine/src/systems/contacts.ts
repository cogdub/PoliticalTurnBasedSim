/**
 * Unprompted contact: AI governments reach out to the player when their own
 * interests call for it (requests, offers, warnings). Messages are free; any
 * proposal they carry is a normal typed proposal the player can sign or decline.
 */
import type { TurnContext } from "../core/context.js";
import { nextId } from "../core/context.js";
import { sortedKeys } from "../core/math.js";
import { countryName, gdp, isAtWar, rel, sharesOrg, warBetween } from "../state/queries.js";
import type { Clause, CountryId, WorldState } from "../state/types.js";
import { evaluateProposal, maxThreat } from "../ai/evaluator.js";
import { forcesNearBorder } from "./diplomacy.js";

const COOLDOWN = 3;

export function contactsPhase(ctx: TurnContext) {
  const { state } = ctx;
  const me = state.meta.playerCountryId;
  const player = state.countries[me];
  for (const id of sortedKeys(state.countries)) {
    const c = state.countries[id];
    if (id === me || !c.playable || c.status !== "sovereign") continue;
    const last = c.strategy.recent["contact:player"] ?? -99;
    if (ctx.turn - last < COOLDOWN) continue;
    const r = rel(state, id, me);
    const leader = state.persons[c.government.leader];
    const sign = `— ${leader?.title ?? "Leader"} ${leader?.name ?? ""}`.trim();
    let sent = false;

    // 1) A partner at war asks the player for help.
    if (!sent && isAtWar(state, id) && r.opinion > 25 && !warBetween(state, id, me)) {
      const amount = Math.max(0.2, Math.round(gdp(player) * 0.001 * 10) / 10);
      sent = offer(ctx, id, me, "Request for military assistance", `Our soldiers are holding the line, but we are short of air defense and ammunition. Every month of support saves lives. Could ${player.name} commit $${amount}bn in military aid? ${sign}`, [{ type: "MilitaryAid", from: me, to: id, amount }]);
    }
    // 2) A threatened ally asks for forward-deployed forces.
    if (!sent && sharesOrg(state, id, me, "military_alliance") && maxThreat(state, id) > 0.5 && r.opinion > 30 && gdp(player) > gdp(c) * 1.5) {
      sent = offer(ctx, id, me, "Request for allied presence", `Hostile forces are massing on our borders. A visible ${player.adjective} presence on our soil would strengthen deterrence. Will you station forces with us? ${sign}`, [{ type: "ForcePresence", from: id, to: me, text: `${player.adjective} forces stationed in ${c.name}` }]);
    }
    // 3) The US presses allies who underspend on defense.
    if (!sent && id === "USA" && sharesOrg(state, id, me, "military_alliance") && player.economy.spending.defense < 0.035) {
      message(ctx, id, me, "Burden sharing", `${player.name} spends ${(player.economy.spending.defense * 100).toFixed(1)}% of GDP on defense. That's not fair to the American taxpayer. We expect allies to move to 5%. Those who pay will be remembered. ${sign}`);
      sent = true;
    }
    // 4) An adversary warns the player about troops near its border.
    if (!sent && r.opinion < -30 && !warBetween(state, id, me) && forcesNearBorder(state, me, id) > 0.35) {
      message(ctx, id, me, "Warning", `We note the concentration of ${player.adjective} forces near our border. Any provocation will receive a response. You would be wise to reconsider. ${sign}`);
      r.threat = Math.min(1, r.threat + 0.02);
      sent = true;
    }
    // 5) A neutral power offers mediation in the player's war.
    if (!sent && isAtWar(state, me) && c.strategy.objectives.some((o) => o.kind === "regional_influence") && r.opinion > 0) {
      const war = Object.values(state.wars).find((w) => w.status === "active" && (w.attackers.includes(me) || w.defenders.includes(me)));
      const enemy = war ? (war.attackers.includes(me) ? war.defenders : war.attackers)[0] : undefined;
      if (enemy && !warBetween(state, id, enemy) && state.meta.turn % 6 === 0) {
        sent = offer(ctx, id, me, "Offer of mediation", `${c.name} is ready to host talks between you and ${countryName(state, enemy)}. A ceasefire along the current line could be a first step. ${sign}`, [{ type: "Ceasefire", from: me, to: enemy, text: "Ceasefire along the current line of contact" }], enemy);
      }
    }
    // 6) A friendly government proposes deeper trade ties.
    if (!sent && r.opinion > 35 && !player.government.euMember && !c.government.euMember && (state.trade.tariffs[me]?.[id] ?? 0) > 0.05 && state.meta.turn % 4 === 1) {
      sent = offer(ctx, id, me, "Trade proposal", `Our economies would both gain from lower barriers. We propose a free trade agreement. ${sign}`, [{ type: "FreeTrade", from: id, to: me }]);
    }
    if (sent) c.strategy.recent["contact:player"] = ctx.turn;
  }
}

function message(ctx: TurnContext, from: CountryId, to: CountryId, subject: string, text: string) {
  ctx.state.inbox.push({ id: nextId(ctx.state, "msg"), turn: ctx.turn + 1, from, subject, text, private: true, read: false });
  ctx.fact({ category: "diplomacy", text: `${countryName(ctx.state, from)} sent a message: ${subject}.`, actors: [from, to], audience: to, public: false });
}

/** Send a proposal only if the sender's own evaluator would honour it. */
function offer(ctx: TurnContext, from: CountryId, to: CountryId, subject: string, text: string, clauses: Clause[], alsoTo?: CountryId): boolean {
  const state: WorldState = ctx.state;
  const ev = evaluateProposal(state, from, { from: to, clauses });
  if (!ev.accept && !clauses.some((c) => c.from === to)) return false;
  const id = nextId(state, "prop");
  state.proposals[id] = { id, from, to: alsoTo ? [to, alsoTo] : [to], clauses, summary: subject, createdTurn: ctx.turn, status: "open", responses: { [from]: { accept: true, utility: ev.utility, reason: "initiated" } }, via: "ai" };
  state.inbox.push({ id: nextId(state, "msg"), turn: ctx.turn + 1, from, subject, proposalId: id, text, private: true, read: false });
  return true;
}
