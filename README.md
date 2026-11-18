# makefun-btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/syahruldy/makefun-btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/syahruldy/makefun-btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

BTC Predator v5 — a deterministic cbBTC 1-minute trading bot for make.fun's
"Race a BTC trading bot live for 24 hours" ($250 in USDC, $1,000 paper,
long-only). Three entry modes: RECLAIM (deep dip below SMA(20) + reclaim of
the swept 20-bar low, gated by RSI and an ATR explosion cap), BREAKOUT
always-on (20-bar-high breakout with a 0.20% margin, ATR expansion with a
2.0x explosion cap, trend and overbought filters, 1.5% extension cap), and
BREAKOUT DEGEN inside the scheduled news windows (Jobless Claims + Philly
Fed, 10Y TIPS auction) with no ATR cap. One position at a time, 100% of cash
per entry, stop/target/trailing exits measured from the actual harness fill
price, 18% internal drawdown brake, flatten from bar 1425. Fully
deterministic: no clock, no network, no randomness.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=j1vfvrf6&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
