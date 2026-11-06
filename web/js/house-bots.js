// HOUSE BOTS: five stalls run by a script, not by people, so the row stays alive while nobody plays.
//
// They are ordinary players to the contract: each is the implicit account of its own key, founded its
// stall with `found`, gets the same starter grant and plays through `act` by the same rules as
// everyone. Their keys are not in this repository; scripts/house-bots.mjs runs them from a GitHub
// Actions workflow (.github/workflows/town.yml). This list only lets the page label their stalls.
// Their names start with "Bot - " (the contract allows letters, digits, spaces, - and ' in names).

export const HOUSE_BOTS = [
  { account: '728c21065a3a9d06f535964b3b8fac6775a3bfacf3ca8b2b3b748365c610718f', name: 'Bot - Tin Kettle', strategy: 'restocker', rule: 'Refills a fixed mix and asks the fair price.' },
  { account: 'a1f66e8043c6f6e16d46dd6d26f5044e48cd791769bd694b44ecbe763b176c7d', name: 'Bot - Brass Ladle', strategy: 'discounter', rule: 'Refills tea, oil and dumplings and asks 90% of the fair price.' },
  { account: '1a1b3bee424b62181e34caaecdff7ddedc2f4eafffb1db1c9d671488b18f55b3', name: 'Bot - Paper Moon', strategy: 'watcher', rule: 'Asks 3% under the cheapest rival, between 95% and 140% of the fair price.' },
  { account: 'ffe0c50fd7beaf30df6a5f1ed1a07701f6b998ba6ed5a2880fd307dd9553eae6', name: 'Bot - Copper Wick', strategy: 'shadow', rule: 'Asks 10% under the cheapest merchant and ignores the players.' },
  { account: '43af45cf153a317edbdf195a633d7ab5958467f6a86925d3a05f017767dab6e4', name: 'Bot - Silk Purse', strategy: 'premium', rule: 'Carries silk, charms, oil and tea at 125% of the fair price.' },
]

const BY_ACCOUNT = new Map(HOUSE_BOTS.map((b) => [b.account, b]))

/** The house bot behind an account, or null. */
export function houseBot(account) {
  return (account && BY_ACCOUNT.get(account)) || null
}

/** True when the stall (or leaderboard row) belongs to a house bot. */
export function isHouseBot(stall) {
  return !!stall && !stall.npc && BY_ACCOUNT.has(stall.owner)
}
