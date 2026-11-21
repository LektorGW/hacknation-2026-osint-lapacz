# Monitoring: stan rejestru źródeł

Próba z 2026-11-21 (`node scripts/monitor-check.ts`): jeden przebieg `discover`, limit 20 postów na źródło, 8 hostów naraz, czas 162 s.

## Trzy liczby

| | Odrębne hosty | Odrębne społeczności | Wpisy |
|---|---|---|---|
| Rejestr — wpisy włączone | 609 | 734 | 843 (wszystkich: 992) |
| Rejestr — bez wpisów o niskiej trafności | 528 | 653 | 760 |
| Odpowiedziały w próbie (zwróciły publikacje) | 599 | 724 | 831 |
| Odpowiedziały w próbie — bez wpisów o niskiej trafności | 518 | 643 | 749 |

Host: dla forów, kanałów RSS i Discourse — host strony; Reddit i Telegram to po jednym hoście; dla Mastodona i Lemmy — host instancji. Społeczność: host forum, subreddit, kanał Telegram, społeczność Lemmy na instancji. Niska trafność: wpisy, których `note` zawiera „niska trafność” lub „niższa trafność” (ogólne fora niezwiązane z krypto, powtórzone strumienie federowanych hashtagów).

## Wynik próby

- Źródeł w próbie: 843; działa: 831, błąd: 5, odmowa (403/429): 6, pusto: 1.
- Publikacji łącznie: 14785, w tym z adresem kryptowalutowym: 326.
- Żądań łącznie: 876.
- Hosty, które odmówiły (reszta ich kolejki pominięta): www.se7ensins.com, forums.babypips.com, linustechtips.com, www.namepros.com, malwaretips.com, rune-server.org.
- Pliki rejestru: core.json, discourse.json, feeds-forums.json, polska.json, reddit.json, telegram-fediverse.json.

## Wpisy włączone według silnika, języka i regionu

| | Rejestr | Odpowiedziały |
|---|---|---|
| Silnik | discourse: 304, rss: 202, mastodon-tag: 133, telegram: 82, lemmy: 71, smf-board: 20, stackexchange: 17, hn: 14 | discourse: 303, rss: 196, mastodon-tag: 132, telegram: 82, lemmy: 71, smf-board: 19, hn: 14, stackexchange: 14 |
| Język | en: 597, pl: 109, de: 31, ru: 21, fr: 11, zh: 11, ja: 9, it: 7, es: 6, pt: 6, tr: 5, vi: 5, cs: 4, sv: 3, uk: 3, fi: 2, id: 2, nl: 2, sr: 2, da: 1, el: 1, eu: 1, fa: 1, ko: 1, no: 1, th: 1 | en: 587, pl: 108, de: 31, ru: 21, zh: 11, fr: 10, ja: 9, it: 7, es: 6, pt: 6, tr: 5, vi: 5, cs: 4, sv: 3, uk: 3, fi: 2, id: 2, nl: 2, sr: 2, da: 1, el: 1, eu: 1, fa: 1, ko: 1, no: 1, th: 1 |
| Region | global: 555, PL: 114, DE: 26, RU: 15, GB: 13, FR: 11, JP: 9, IN: 8, IT: 7, AU: 6, CA: 6, CN: 6, US: 6, TR: 5, VN: 5, BR: 4, CZ: 4, ES: 4, UA: 4, AT: 3, CH: 3, SE: 3, FI: 2, ID: 2, IE: 2, NL: 2, NZ: 2, PT: 2, RS: 2, SG: 2, ZA: 2, DK: 1, GR: 1, IR: 1, KR: 1, MX: 1, NO: 1, TH: 1, TW: 1 | global: 545, PL: 113, DE: 26, RU: 15, GB: 13, FR: 10, JP: 9, IN: 8, IT: 7, AU: 6, CA: 6, CN: 6, US: 6, TR: 5, VN: 5, BR: 4, CZ: 4, ES: 4, UA: 4, AT: 3, CH: 3, SE: 3, FI: 2, ID: 2, IE: 2, NL: 2, NZ: 2, PT: 2, RS: 2, SG: 2, ZA: 2, DK: 1, GR: 1, IR: 1, KR: 1, MX: 1, NO: 1, TH: 1, TW: 1 |

## Źródła, które nie zwróciły publikacji

| Źródło (id) | Silnik | Wynik | Powód |
|---|---|---|---|
| Tor Stack Exchange (`stackexchange-tor`) | stackexchange | błąd | api.stackexchange.com — kod 400. |
| Economics Stack Exchange (`stackexchange-economics`) | stackexchange | błąd | api.stackexchange.com — kod 400. |
| Law Stack Exchange (`stackexchange-law`) | stackexchange | błąd | api.stackexchange.com — kod 400. |
| Se7enSins — całe forum (`rss-se7ensins-all`) | rss | odmowa (403/429) | www.se7ensins.com — odmowa lub limit żądań (kod 403); pomijam to źródło. |
| Mastodon 101010.pl — #kryptowaluty (`masto-101010-kryptowaluty`) | mastodon-tag | błąd | 101010.pl — przekroczono limit czasu lub przerwano. |
| Bitcointalk — Français — Place de marché (`btt-49`) | smf-board | pusto | — |
| Babypips (forum, forums.babypips.com) (`discourse-forums-babypips-com`) | discourse | odmowa (403/429) | forums.babypips.com — odmowa lub limit żądań (kod 403); pomijam to źródło. |
| Hacker News przez hnrss.org — „bitcoin address” (`rss-hnrss-bitcoin-address`) | rss | błąd | hnrss.org — kod 502. |
| Linus Tech Tips — Folding@home, Boinc, and Coin Mining (`rss-linustechtips-mining`) | rss | odmowa (403/429) | linustechtips.com — odmowa lub limit żądań (kod 403); pomijam to źródło. |
| NamePros — Blockchain and Cryptocurrencies (`rss-namepros-crypto`) | rss | odmowa (403/429) | www.namepros.com — odmowa lub limit żądań (kod 403); pomijam to źródło. |
| MalwareTips — Cryptocurrency Talk (`rss-malwaretips-crypto`) | rss | odmowa (403/429) | malwaretips.com — odmowa lub limit żądań (kod 403); pomijam to źródło. |
| Rune-Server (handel RuneScape) (`rss-rune-server`) | rss | odmowa (403/429) | rune-server.org — odmowa lub limit żądań (kod 403); pomijam to źródło. |

## Ostrzeżenia rejestru (wpisy błędne i powtórzone)

- discourse.json#45 („discourse-delvingbitcoin-org"): pominięto — to samo źródło co core.json#27 („dsc-delvingbitcoin").
- discourse.json#67 („discourse-ethereum-magicians-org"): pominięto — to samo źródło co core.json#25 („dsc-ethereum-magicians").
- discourse.json#68 („discourse-ethresear-ch"): pominięto — to samo źródło co core.json#26 („dsc-ethresearch").
- feeds-forums.json#152 („stackexchange-bitcoin"): pominięto — to samo źródło co core.json#21 („se-bitcoin").
- feeds-forums.json#153 („stackexchange-ethereum"): pominięto — to samo źródło co core.json#22 („se-ethereum").
- feeds-forums.json#169 („hn-bitcoin-address"): pominięto — „id" powtórzone (pierwsze wystąpienie: core.json#23 („hn-bitcoin-address")).
- feeds-forums.json#170 („hn-donate-btc"): pominięto — „id" powtórzone (pierwsze wystąpienie: core.json#24 („hn-donate-btc")).
- telegram-fediverse.json#92 („mastodon-tag-mastodon-social-bitcoin"): pominięto — to samo źródło co core.json#28 („masto-social-bitcoin").
- telegram-fediverse.json#127 („mastodon-tag-mastodon-social-kryptowaluty"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#87 („mastodon-tag-mastodon-social-kryptowaluty")).
- telegram-fediverse.json#153 („mastodon-tag-wspanialy-eu-bitcoin"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#85 („mastodon-tag-wspanialy-eu-bitcoin")).
- telegram-fediverse.json#207 („mastodon-tag-wspanialy-eu-kryptowaluty"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#83 („mastodon-tag-wspanialy-eu-kryptowaluty")).
- telegram-fediverse.json#208 („mastodon-tag-mastodon-com-pl-kryptowaluty"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#80 („mastodon-tag-mastodon-com-pl-kryptowaluty")).
- telegram-fediverse.json#213 („lemmy-lemmy-world-bitcoin"): pominięto — to samo źródło co core.json#30 („lemmy-world-bitcoin").
- telegram-fediverse.json#245 („lemmy-lemmy-world-polska"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#99 („lemmy-lemmy-world-polska")).
- telegram-fediverse.json#271 („lemmy-lemmy-ml-polska"): pominięto — „id" powtórzone (pierwsze wystąpienie: polska.json#102 („lemmy-lemmy-ml-polska")).

## Źródła działające

| Źródło (id) | Silnik | Host | Język | Posty | Z autorem | Z adresami | Najnowszy |
|---|---|---|---|---|---|---|---|
| lemmy.ml c/polska (`lemmy-lemmy-ml-polska`) | lemmy | lemmy.ml/c/polska | pl | 20 | 20 | 0 | 2025-12-15 |
| Binance Announcements (Telegram @binance_announcements) (`telegram-binance-announcements`) | telegram | t.me/binance_announcements | en | 20 | 20 | 0 | 2026-11-20 |
| Lemmy lemmy.world — bitcoin (`lemmy-world-bitcoin`) | lemmy | lemmy.world/c/bitcoin | en | 20 | 20 | 0 | 2026-11-20 |
| Bitcoin Stack Exchange (`se-bitcoin`) | stackexchange | bitcoin.stackexchange.com | en | 20 | 20 | 1 | 2026-11-20 |
| mastodon.online #kryptowaluty (`mastodon-tag-mastodon-online-kryptowaluty`) | mastodon-tag | mastodon.online | pl | 17 | 17 | 0 | 2026-11-13 |
| Mastodon mastodon.social — #bitcoin (`masto-social-bitcoin`) | mastodon-tag | mastodon.social | en | 18 | 18 | 0 | 2026-11-21 |
| Hacker News — „bitcoin address" (`hn-bitcoin-address`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-18 |
| lemmy.ml c/poland (`lemmy-lemmy-ml-poland`) | lemmy | lemmy.ml/c/poland | en | 6 | 6 | 0 | 2026-05-08 |
| lemmy.world c/polska (`lemmy-lemmy-world-polska`) | lemmy | lemmy.world/c/polska | pl | 20 | 20 | 0 | 2026-11-09 |
| Ethereum Stack Exchange (`se-ethereum`) | stackexchange | ethereum.stackexchange.com | en | 20 | 20 | 5 | 2026-11-14 |
| #bitcoin @ mastodon.online (Mastodon) (`mastodon-tag-mastodon-online-bitcoin`) | mastodon-tag | mastodon.online | en | 19 | 19 | 0 | 2026-11-21 |
| Hacker News — „donate BTC" (`hn-donate-btc`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-20 |
| mastodon.social #kryptowaluty (`mastodon-tag-mastodon-social-kryptowaluty`) | mastodon-tag | mastodon.social | pl | 17 | 17 | 0 | 2026-11-18 |
| Bitcoin – !bitcoin@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-bitcoin`) | lemmy | lemmy.ml/c/bitcoin | en | 20 | 20 | 0 | 2026-11-13 |
| lemmy.world c/poland (`lemmy-lemmy-world-poland`) | lemmy | lemmy.world/c/poland | en | 7 | 7 | 0 | 2026-06-12 |
| OKX Announcements (Telegram @OKXAnnouncements) (`telegram-okxannouncements`) | telegram | t.me/okxannouncements | en | 20 | 20 | 0 | 2026-11-21 |
| Monero Stack Exchange (`stackexchange-monero`) | stackexchange | monero.stackexchange.com | en | 20 | 20 | 0 | 2026-11-19 |
| #crypto @ mastodon.online (Mastodon) (`mastodon-tag-mastodon-online-crypto`) | mastodon-tag | mastodon.online | en | 14 | 14 | 0 | 2026-11-21 |
| Hacker News — komentarze: „USDT TRC20” (`hn-usdt-trc20`) | hn | news.ycombinator.com | en | 20 | 20 | 2 | 2026-04-08 |
| mastodon.social #giełda (`mastodon-tag-mastodon-social-gielda`) | mastodon-tag | mastodon.social | pl | 20 | 20 | 0 | 2026-11-20 |
| szmer.info c/technologia (przez lemmy.world) (`lemmy-lemmy-world-technologia-szmer-info`) | lemmy | lemmy.world/c/technologia@szmer.info | pl | 20 | 20 | 0 | 2026-11-18 |
| cryptocurrency – !crypto@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-crypto`) | lemmy | lemmy.ml/c/crypto | en | 20 | 20 | 0 | 2026-11-02 |
| #blockchain @ mastodon.online (Mastodon) (`mastodon-tag-mastodon-online-blockchain`) | mastodon-tag | mastodon.online | en | 19 | 19 | 0 | 2026-11-21 |
| Cardano Stack Exchange (`stackexchange-cardano`) | stackexchange | cardano.stackexchange.com | en | 20 | 20 | 0 | 2026-10-16 |
| Hacker News — komentarze: „Monero address” (`hn-monero-address`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-11 |
| mastodon.social #finanse (`mastodon-tag-mastodon-social-finanse`) | mastodon-tag | mastodon.social | pl | 20 | 20 | 0 | 2026-11-16 |
| Cryptocurrency – !cryptocurrency@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-cryptocurrency`) | lemmy | lemmy.ml/c/cryptocurrency | en | 20 | 20 | 0 | 2026-11-01 |
| CryptoCurrency – !cryptocurrency@lemmy.world (Lemmy) (`lemmy-lemmy-world-cryptocurrency`) | lemmy | lemmy.world/c/cryptocurrency | en | 20 | 20 | 0 | 2026-11-16 |
| Bybit Announcements (Telegram @Bybit_Announcements) (`telegram-bybit-announcements`) | telegram | t.me/bybit_announcements | en | 15 | 15 | 0 | 2026-11-21 |
| Tezos Stack Exchange (`stackexchange-tezos`) | stackexchange | tezos.stackexchange.com | en | 20 | 20 | 0 | 2026-05-23 |
| #cryptocurrency @ mastodon.online (Mastodon) (`mastodon-tag-mastodon-online-cryptocurrency`) | mastodon-tag | mastodon.online | en | 5 | 5 | 0 | 2026-11-20 |
| #crypto @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-crypto`) | mastodon-tag | mastodon.social | en | 14 | 14 | 0 | 2026-11-21 |
| Bitcointalk — Polski (`btt-142`) | smf-board | bitcointalk.org | pl | 20 | 20 | 0 | 2026-11-20 |
| mastodon.com.pl #kryptowaluty (`mastodon-tag-mastodon-com-pl-kryptowaluty`) | mastodon-tag | mastodon.com.pl | pl | 16 | 16 | 0 | 2026-11-15 |
| Hacker News — komentarze: „crypto Poland” (`hn-crypto-poland`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-06 |
| Monero – !monero@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-monero`) | lemmy | lemmy.ml/c/monero | en | 20 | 20 | 0 | 2026-10-30 |
| Monero – !monero@lemmy.world (Lemmy) (`lemmy-lemmy-world-monero`) | lemmy | lemmy.world/c/monero | en | 2 | 2 | 0 | 2025-05-16 |
| Solana Stack Exchange (`stackexchange-solana`) | stackexchange | solana.stackexchange.com | en | 20 | 20 | 0 | 2026-11-20 |
| #cryptocurrency @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-cryptocurrency`) | mastodon-tag | mastodon.social | en | 4 | 4 | 0 | 2026-11-20 |
| Hacker News — komentarze: „kryptowaluty” (`hn-kryptowaluty`) | hn | news.ycombinator.com | pl | 2 | 2 | 0 | 2018-02-21 |
| mastodon.com.pl #giełda (`mastodon-tag-mastodon-com-pl-gielda`) | mastodon-tag | mastodon.com.pl | pl | 20 | 20 | 0 | 2026-11-20 |
| Privacy – !privacy@lemmy.world (Lemmy) (`lemmy-lemmy-world-privacy`) | lemmy | lemmy.world/c/privacy | en | 20 | 20 | 0 | 2026-11-21 |
| KuCoin Announcement (Telegram @KuCoin_News) (`telegram-kucoin-news`) | telegram | t.me/kucoin_news | en | 17 | 17 | 0 | 2026-11-21 |
| Privacy – !privacy@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-privacy`) | lemmy | lemmy.ml/c/privacy | en | 20 | 20 | 0 | 2026-11-21 |
| Substrate and Polkadot Stack Exchange (`stackexchange-substrate`) | stackexchange | substrate.stackexchange.com | en | 20 | 20 | 0 | 2026-09-24 |
| Hacker News — komentarze: „Warsaw bitcoin” (`hn-warsaw-bitcoin`) | hn | news.ycombinator.com | en | 3 | 3 | 0 | 2022-11-14 |
| mastodon.com.pl #finanse (`mastodon-tag-mastodon-com-pl-finanse`) | mastodon-tag | mastodon.com.pl | pl | 20 | 20 | 0 | 2026-11-19 |
| #ethereum @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-ethereum`) | mastodon-tag | mastodon.social | en | 18 | 18 | 0 | 2026-11-21 |
| Technology – !technology@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-technology`) | lemmy | lemmy.ml/c/technology | en | 20 | 20 | 0 | 2026-11-21 |
| Technology – !technology@lemmy.world (Lemmy) (`lemmy-lemmy-world-technology`) | lemmy | lemmy.world/c/technology | en | 20 | 20 | 0 | 2026-11-21 |
| IOTA Stack Exchange (`stackexchange-iota`) | stackexchange | iota.stackexchange.com | en | 20 | 20 | 0 | 2026-05-01 |
| #bitcoin @ mastodon.com.pl (Mastodon) (`mastodon-tag-mastodon-com-pl-bitcoin`) | mastodon-tag | mastodon.com.pl | pl | 19 | 19 | 0 | 2026-11-20 |
| #monero @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-monero`) | mastodon-tag | mastodon.social | en | 8 | 8 | 0 | 2026-11-21 |
| Hacker News — komentarze: „sell bitcoin cash” (`hn-sell-bitcoin-cash`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-20 |
| mas.to #kryptowaluty (`mastodon-tag-mas-to-kryptowaluty`) | mastodon-tag | mas.to | pl | 16 | 16 | 0 | 2026-11-18 |
| The Bitcoin Lightning Network – !lightningnetwork@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-lightningnetwork`) | lemmy | lemmy.ml/c/lightningnetwork | en | 7 | 7 | 0 | 2023-10-09 |
| Cryptocurrency E-commerce – !cryptocurrencyecommerce@lemmy.world (Lemmy) (`lemmy-lemmy-world-cryptocurrencyecommerce`) | lemmy | lemmy.world/c/cryptocurrencyecommerce | en | 20 | 20 | 0 | 2024-05-14 |
| HTX Announcements (Telegram @HTX_announcements) (`telegram-htx-announcements`) | telegram | t.me/htx_announcements | en | 17 | 17 | 0 | 2026-11-21 |
| EOS.IO Stack Exchange (`stackexchange-eosio`) | stackexchange | eosio.stackexchange.com | en | 20 | 20 | 0 | 2026-03-23 |
| Hacker News — komentarze: „wallet address bc1q” (`hn-wallet-address-bc1q`) | hn | news.ycombinator.com | en | 12 | 12 | 3 | 2026-10-25 |
| #bitcoin @ mas.to (Mastodon) (`mastodon-tag-mas-to-bitcoin`) | mastodon-tag | mas.to | en | 18 | 18 | 0 | 2026-11-21 |
| Bitcointalk — Polski — Tablica ogłoszeń (`btt-163`) | smf-board | bitcointalk.org | pl | 20 | 20 | 0 | 2026-01-18 |
| #btc @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-btc`) | mastodon-tag | mastodon.social | en | 18 | 18 | 0 | 2026-11-21 |
| Personal Finance – !personalfinance@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-personalfinance`) | lemmy | lemmy.ml/c/personalfinance | en | 20 | 20 | 0 | 2026-11-16 |
| Ethereum – !ethereum@lemmy.world (Lemmy) (`lemmy-lemmy-world-ethereum`) | lemmy | lemmy.world/c/ethereum | en | 8 | 8 | 0 | 2026-04-18 |
| Stellar Stack Exchange (`stackexchange-stellar`) | stackexchange | stellar.stackexchange.com | en | 20 | 20 | 0 | 2026-11-18 |
| #defi @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-defi`) | mastodon-tag | mastodon.social | en | 11 | 11 | 0 | 2026-11-21 |
| Hacker News — komentarze: „ethereum address 0x” (`hn-ethereum-address-0x`) | hn | news.ycombinator.com | en | 20 | 20 | 6 | 2026-08-04 |
| #crypto @ mas.to (Mastodon) (`mastodon-tag-mas-to-crypto`) | mastodon-tag | mas.to | en | 17 | 17 | 0 | 2026-11-21 |
| Ethereum – !ethereum@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-ethereum`) | lemmy | lemmy.ml/c/ethereum | en | 11 | 11 | 0 | 2026-06-02 |
| CryptoScams – !cryptoscams@lemmy.world (Lemmy) (`lemmy-lemmy-world-cryptoscams`) | lemmy | lemmy.world/c/cryptoscams | en | 20 | 20 | 0 | 2026-11-17 |
| Bitget Announcements (Telegram @Bitget_Announcements) (`telegram-bitget-announcements`) | telegram | t.me/bitget_announcements | en | 18 | 18 | 0 | 2026-11-20 |
| Personal Finance & Money Stack Exchange (`stackexchange-money`) | stackexchange | money.stackexchange.com | en | 20 | 20 | 0 | 2026-11-21 |
| #usdt @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-usdt`) | mastodon-tag | mastodon.social | en | 20 | 20 | 0 | 2026-11-19 |
| Hacker News — komentarze: „donations XMR” (`hn-donations-xmr`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-11-20 |
| #ethereum @ mas.to (Mastodon) (`mastodon-tag-mas-to-ethereum`) | mastodon-tag | mas.to | en | 14 | 14 | 0 | 2026-11-21 |
| fosstodon.org #kryptowaluty (`mastodon-tag-fosstodon-org-kryptowaluty`) | mastodon-tag | fosstodon.org | pl | 13 | 13 | 0 | 2026-11-18 |
| Ethereum Developers – !ethdev@lemmy.world (Lemmy) (`lemmy-lemmy-world-ethdev`) | lemmy | lemmy.world/c/ethdev | en | 8 | 8 | 1 | 2025-12-26 |
| Scams – !scams@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-scams`) | lemmy | lemmy.ml/c/scams | en | 16 | 16 | 0 | 2026-10-01 |
| Quantitative Finance Stack Exchange (`stackexchange-quant`) | stackexchange | quant.stackexchange.com | en | 20 | 20 | 0 | 2026-11-17 |
| #lightning @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-lightning`) | mastodon-tag | mastodon.social | en | 15 | 15 | 0 | 2026-11-21 |
| Hacker News — komentarze: „bitcoin Polska” (`hn-bitcoin-polska`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2025-12-08 |
| #bitcoin @ fosstodon.org (Mastodon) (`mastodon-tag-fosstodon-org-bitcoin`) | mastodon-tag | fosstodon.org | en | 18 | 18 | 0 | 2026-11-21 |
| Finance – !finance@lemmy.world (Lemmy) (`lemmy-lemmy-world-finance`) | lemmy | lemmy.world/c/finance | en | 5 | 5 | 0 | 2026-11-12 |
| Gram of TON (Telegram @toncoin) (`telegram-toncoin`) | telegram | t.me/toncoin | en | 19 | 19 | 0 | 2026-07-21 |
| Cryptography – !cryptography@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-cryptography`) | lemmy | lemmy.ml/c/cryptography | en | 20 | 20 | 0 | 2026-10-18 |
| Cryptography Stack Exchange (`stackexchange-crypto`) | stackexchange | crypto.stackexchange.com | en | 20 | 20 | 0 | 2026-11-19 |
| Bitcointalk — Polski — Alternatywne kryptowaluty (`btt-164`) | smf-board | bitcointalk.org | pl | 20 | 20 | 0 | 2019-10-07 |
| #nostr @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-nostr`) | mastodon-tag | mastodon.social | en | 19 | 19 | 0 | 2026-11-20 |
| #monero @ fosstodon.org (Mastodon) (`mastodon-tag-fosstodon-org-monero`) | mastodon-tag | fosstodon.org | en | 12 | 12 | 0 | 2026-11-21 |
| Hacker News — komentarze: „P2P crypto exchange” (`hn-p2p-crypto-exchange`) | hn | news.ycombinator.com | en | 20 | 20 | 0 | 2026-10-30 |
| Cryptocurrency News & Discussion – !cryptoassets@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-cryptoassets`) | lemmy | lemmy.ml/c/cryptoassets | en | 13 | 13 | 0 | 2026-05-08 |
| CryptoTechnology – !cryptotechnology@lemmy.world (Lemmy) (`lemmy-lemmy-world-cryptotechnology`) | lemmy | lemmy.world/c/cryptotechnology | en | 4 | 4 | 0 | 2025-11-06 |
| #blockchain @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-blockchain`) | mastodon-tag | mastodon.social | en | 18 | 18 | 0 | 2026-11-21 |
| #blockchain @ fosstodon.org (Mastodon) (`mastodon-tag-fosstodon-org-blockchain`) | mastodon-tag | fosstodon.org | en | 16 | 16 | 0 | 2026-11-20 |
| Hacker News — komentarze: „lightning address tips” (`hn-lightning-address-tips`) | hn | news.ycombinator.com | en | 12 | 12 | 0 | 2025-02-10 |
| Cryptocurrency Markets – !cryptomarkets@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-cryptomarkets`) | lemmy | lemmy.ml/c/cryptomarkets | en | 9 | 9 | 0 | 2026-03-19 |
| The Open Network (Telegram @tonblockchain) (`telegram-tonblockchain`) | telegram | t.me/tonblockchain | en | 20 | 20 | 0 | 2024-06-01 |
| cryptomarkets – !cryptomarkets@lemmy.world (Lemmy) (`lemmy-lemmy-world-cryptomarkets`) | lemmy | lemmy.world/c/cryptomarkets | en | 4 | 4 | 0 | 2026-05-03 |
| Information Security Stack Exchange (`stackexchange-security`) | stackexchange | security.stackexchange.com | en | 20 | 20 | 0 | 2026-11-21 |
| mastodon.world #kryptowaluty (`mastodon-tag-mastodon-world-kryptowaluty`) | mastodon-tag | mastodon.world | pl | 14 | 14 | 0 | 2026-11-18 |
| hachyderm.io #kryptowaluty (`mastodon-tag-hachyderm-io-kryptowaluty`) | mastodon-tag | hachyderm.io | pl | 14 | 14 | 0 | 2026-11-18 |
| techhub.social #kryptowaluty (`mastodon-tag-techhub-social-kryptowaluty`) | mastodon-tag | techhub.social | pl | 13 | 13 | 0 | 2026-10-31 |
| Cryptocurrency news and discussions – !cryptocurrencies@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-cryptocurrencies`) | lemmy | lemmy.ml/c/cryptocurrencies | en | 9 | 9 | 0 | 2026-04-11 |
| #bitcoin @ mastodon.world (Mastodon) (`mastodon-tag-mastodon-world-bitcoin`) | mastodon-tag | mastodon.world | en | 20 | 20 | 0 | 2026-11-21 |
| #crypto @ hachyderm.io (Mastodon) (`mastodon-tag-hachyderm-io-crypto`) | mastodon-tag | hachyderm.io | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ techhub.social (Mastodon) (`mastodon-tag-techhub-social-bitcoin`) | mastodon-tag | techhub.social | en | 17 | 17 | 0 | 2026-11-21 |
| #donate @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-donate`) | mastodon-tag | mastodon.social | en | 20 | 20 | 0 | 2026-11-21 |
| XMR Trader, the Official Monero Trading SubLemmy – !xmrtrader@lemmy.ml (Lemmy) (`lemmy-lemmy-ml-xmrtrader`) | lemmy | lemmy.ml/c/xmrtrader | en | 1 | 1 | 0 | 2021-08-31 |
| #crypto @ mastodon.world (Mastodon) (`mastodon-tag-mastodon-world-crypto`) | mastodon-tag | mastodon.world | en | 19 | 19 | 0 | 2026-11-21 |
| Pavel Durov (Telegram @durov) (`telegram-durov`) | telegram | t.me/durov | en | 20 | 20 | 0 | 2026-11-20 |
| #giveaway @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-giveaway`) | mastodon-tag | mastodon.social | en | 20 | 20 | 0 | 2026-11-21 |
| #blockchain @ hachyderm.io (Mastodon) (`mastodon-tag-hachyderm-io-blockchain`) | mastodon-tag | hachyderm.io | en | 19 | 19 | 0 | 2026-11-21 |
| Bitcointalk — Marketplace (`btt-5`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2026-10-20 |
| cryptocurrency – !cryptocurrency@lemmy.ca (Lemmy) (`lemmy-lemmy-ca-cryptocurrency`) | lemmy | lemmy.ca/c/cryptocurrency | en | 8 | 8 | 0 | 2026-06-25 |
| #crypto @ techhub.social (Mastodon) (`mastodon-tag-techhub-social-crypto`) | mastodon-tag | techhub.social | en | 18 | 18 | 0 | 2026-11-21 |
| Medium — tag bitcoin (`rss-medium-bitcoin`) | rss | medium.com | en | 10 | 10 | 0 | 2026-11-21 |
| #cryptocurrency @ mastodon.world (Mastodon) (`mastodon-tag-mastodon-world-cryptocurrency`) | mastodon-tag | mastodon.world | en | 19 | 19 | 0 | 2026-11-21 |
| #blockchain @ techhub.social (Mastodon) (`mastodon-tag-techhub-social-blockchain`) | mastodon-tag | techhub.social | en | 19 | 19 | 0 | 2026-11-21 |
| privacy – !privacy@lemmy.ca (Lemmy) (`lemmy-lemmy-ca-privacy`) | lemmy | lemmy.ca/c/privacy | en | 20 | 20 | 0 | 2026-11-21 |
| #scam @ hachyderm.io (Mastodon) (`mastodon-tag-hachyderm-io-scam`) | mastodon-tag | hachyderm.io | en | 1 | 1 | 0 | 2026-11-21 |
| Make-Cash.pl — Dyskusje o kryptowalutach (`rss-make-cash-dyskusje-o-kryptowalutach`) | rss | make-cash.pl | pl | 20 | 0 | 0 | 2026-08-17 |
| #airdrop @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-airdrop`) | mastodon-tag | mastodon.social | en | 16 | 16 | 0 | 2026-11-19 |
| Medium — tag cryptocurrency (`rss-medium-cryptocurrency`) | rss | medium.com | en | 9 | 9 | 0 | 2026-11-21 |
| Forex-Nawigator — wszystkie posty (`rss-forex-nawigator-posty`) | rss | forex-nawigator.biz | pl | 20 | 20 | 0 | 2026-11-21 |
| Wykop.pl — strona główna (`rss-wykop-strona-glowna`) | rss | wykop.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Telegram News (Telegram @telegram) (`telegram-telegram`) | telegram | t.me/telegram | en | 20 | 20 | 0 | 2026-08-26 |
| Personal Finance Canada – !personalfinancecanada@lemmy.ca (Lemmy) (`lemmy-lemmy-ca-personalfinancecanada`) | lemmy | lemmy.ca/c/personalfinancecanada | en | 20 | 20 | 0 | 2026-11-10 |
| #scam @ mastodon.social (Mastodon) (`mastodon-tag-mastodon-social-scam`) | mastodon-tag | mastodon.social | en | 5 | 5 | 0 | 2026-11-21 |
| Medium — tag „kryptowaluty” (`rss-medium-tag-kryptowaluty`) | rss | medium.com | pl | 8 | 8 | 0 | 2026-11-18 |
| Forex-Nawigator — nowe tematy (`rss-forex-nawigator-nowe-tematy`) | rss | forex-nawigator.biz | pl | 20 | 20 | 0 | 2026-11-19 |
| Make-Cash.pl — Giełdy, portfele, kantory i bitomaty (`rss-make-cash-gieldy-portfele-kantory`) | rss | make-cash.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Wykop.pl — Wykopalisko (`rss-wykop-wykopalisko`) | rss | wykop.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Forum benchmark.pl — Giełda: Sprzedam (`rss-benchmark-sprzedam`) | rss | forum.benchmark.pl | pl | 20 | 0 | 0 | 2026-11-20 |
| Forum PurePC — Giełda: Sprzedam (`rss-purepc-sprzedam`) | rss | forum.purepc.pl | pl | 20 | 0 | 0 | 2026-11-08 |
| Crypto Canada – !cryptocanada@lemmy.ca (Lemmy) (`lemmy-lemmy-ca-cryptocanada`) | lemmy | lemmy.ca/c/cryptocanada | en | 1 | 1 | 0 | 2023-01-28 |
| Forum ITHardware (d. PCLab) — Giełda: Sprzedam (`rss-ithardware-sprzedam`) | rss | forum.ithardware.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Make-Cash.pl — Airdropy i kraniki kryptowalut (`rss-make-cash-airdropy-kraniki`) | rss | make-cash.pl | pl | 20 | 0 | 2 | 2026-10-15 |
| Forex-Nawigator — Brokerzy Forex (`rss-forex-nawigator-brokerzy`) | rss | forex-nawigator.biz | pl | 20 | 20 | 0 | 2026-11-15 |
| Forum PurePC — Giełda: Kupię (`rss-purepc-kupie`) | rss | forum.purepc.pl | pl | 14 | 0 | 0 | 2026-10-17 |
| Wykop.pl — komentowane znaleziska (`rss-wykop-komentowane`) | rss | wykop.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Forum benchmark.pl — Giełda: Kupię (`rss-benchmark-kupie`) | rss | forum.benchmark.pl | pl | 20 | 0 | 0 | 2026-08-23 |
| feddit.org c/polska (`lemmy-feddit-org-polska`) | lemmy | feddit.org/c/polska | pl | 2 | 2 | 0 | 2026-03-11 |
| #bitcoin @ social.tchncs.de (Mastodon) (`mastodon-tag-social-tchncs-de-bitcoin`) | mastodon-tag | social.tchncs.de | de | 14 | 14 | 0 | 2026-11-21 |
| wspanialy.eu #kryptowaluty (`mastodon-tag-wspanialy-eu-kryptowaluty`) | mastodon-tag | wspanialy.eu | pl | 12 | 12 | 0 | 2026-11-18 |
| Whale Alert (Telegram @whale_alert_io) (`telegram-whale-alert-io`) | telegram | t.me/whale_alert_io | en | 20 | 20 | 0 | 2026-11-21 |
| Forum ITHardware (d. PCLab) — Giełda: Kupię (`rss-ithardware-kupie`) | rss | forum.ithardware.pl | pl | 20 | 0 | 0 | 2026-11-19 |
| Bitcointalk — Goods (`btt-51`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2025-07-11 |
| Forum PurePC — nowe tematy (`rss-purepc-nowe-tematy`) | rss | forum.purepc.pl | pl | 20 | 0 | 0 | 2026-11-20 |
| Finanzen – !finanzen@feddit.org (Lemmy) (`lemmy-feddit-org-finanzen`) | lemmy | feddit.org/c/finanzen | de | 20 | 20 | 0 | 2026-11-21 |
| Forum benchmark.pl — kanał forum (`rss-benchmark-forum`) | rss | forum.benchmark.pl | pl | 20 | 0 | 0 | 2026-11-20 |
| Bitcoin – !bitcoin@infosec.pub (Lemmy) (`lemmy-infosec-pub-bitcoin`) | lemmy | infosec.pub/c/bitcoin | en | 20 | 20 | 0 | 2026-03-22 |
| wspanialy.eu #giełda (`mastodon-tag-wspanialy-eu-gielda`) | mastodon-tag | wspanialy.eu | pl | 20 | 20 | 0 | 2026-11-20 |
| #krypto @ social.tchncs.de (Mastodon) (`mastodon-tag-social-tchncs-de-krypto`) | mastodon-tag | social.tchncs.de | de | 19 | 19 | 0 | 2026-11-17 |
| Po polsku lub o Polsce – !polska@sopuli.xyz (Lemmy) (`lemmy-sopuli-xyz-polska`) | lemmy | sopuli.xyz/c/polska | pl | 20 | 20 | 0 | 2026-11-21 |
| Forum ITHardware (d. PCLab) — cała aktywność (`rss-ithardware-cala-aktywnosc`) | rss | forum.ithardware.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Datenschutz - Privacy - Digitale Selbstverteidigung – !datenschutz@feddit.org (Lemmy) (`lemmy-feddit-org-datenschutz`) | lemmy | feddit.org/c/datenschutz | de | 20 | 20 | 0 | 2026-11-19 |
| cybersecurity – !cybersecurity@infosec.pub (Lemmy) (`lemmy-infosec-pub-cybersecurity`) | lemmy | infosec.pub/c/cybersecurity | en | 18 | 18 | 0 | 2026-11-20 |
| #monero @ social.tchncs.de (Mastodon) (`mastodon-tag-social-tchncs-de-monero`) | mastodon-tag | social.tchncs.de | de | 6 | 6 | 0 | 2026-11-21 |
| Privacy – !privacy@sopuli.xyz (Lemmy) (`lemmy-sopuli-xyz-privacy`) | lemmy | sopuli.xyz/c/privacy | en | 19 | 19 | 0 | 2026-11-21 |
| Stacker News — wszystkie wpisy (`rss-stackernews-all`) | rss | stacker.news | en | 20 | 0 | 0 | 2026-11-21 |
| wspanialy.eu #bitcoin (`mastodon-tag-wspanialy-eu-bitcoin`) | mastodon-tag | wspanialy.eu | pl | 17 | 17 | 1 | 2026-11-17 |
| DEV Community — tag bitcoin (`rss-devto-bitcoin`) | rss | dev.to | en | 12 | 12 | 0 | 2026-11-21 |
| Cointelegraph (Telegram @cointelegraph) (`telegram-cointelegraph`) | telegram | t.me/cointelegraph | en | 13 | 13 | 0 | 2026-11-21 |
| Bits.media forum — p2p обмен валют (`rss-bitsmedia-p2p`) | rss | forum.bits.media | ru | 20 | 0 | 0 | 2026-11-16 |
| Stacker News — terytorium ~bitcoin (`rss-stackernews-bitcoin`) | rss | stacker.news | en | 20 | 0 | 0 | 2026-11-20 |
| Ethereum – !ethereum@infosec.pub (Lemmy) (`lemmy-infosec-pub-ethereum`) | lemmy | infosec.pub/c/ethereum | en | 5 | 5 | 0 | 2025-06-12 |
| DEV Community — tag cryptocurrency (`rss-devto-cryptocurrency`) | rss | dev.to | en | 12 | 12 | 0 | 2026-11-21 |
| Personal Finance 💸 – !personalfinance@sopuli.xyz (Lemmy) (`lemmy-sopuli-xyz-personalfinance`) | lemmy | sopuli.xyz/c/personalfinance | en | 17 | 17 | 0 | 2026-08-28 |
| Bits.media forum — Кошельки для криптовалют (`rss-bitsmedia-wallets`) | rss | forum.bits.media | ru | 20 | 0 | 0 | 2026-10-15 |
| Digital Point — Payment Processing (`rss-digitalpoint-payment-processing`) | rss | forums.digitalpoint.com | en | 20 | 20 | 0 | 2026-11-17 |
| MMGP — Криптовалюта (`rss-mmgp-kriptovaljuta`) | rss | mmgp.com | ru | 20 | 20 | 0 | 2026-11-21 |
| Habr — hub Криптовалюты (`rss-habr-cryptocurrency`) | rss | habr.com | ru | 20 | 20 | 0 | 2026-11-20 |
| Digital Point — Payments (`rss-digitalpoint-payments`) | rss | forums.digitalpoint.com | en | 20 | 20 | 0 | 2026-07-28 |
| LowEndTalk — Offers (`rss-lowendtalk-offers`) | rss | lowendtalk.com | en | 20 | 20 | 0 | 2026-11-20 |
| GitHub Discussions — btcpayserver/btcpayserver (`rss-github-btcpayserver-discussions`) | rss | github.com | en | 20 | 20 | 0 | 2026-11-12 |
| Carbonite — Cryptocurrencies (`rss-carbonite-cryptocurrencies`) | rss | carbonite.co.za | en | 20 | 20 | 0 | 2026-07-06 |
| WordPress.com — tag bitcoin (`rss-wordpresscom-bitcoin`) | rss | wordpress.com | en | 20 | 20 | 8 | 2026-11-21 |
| MMGP — całe forum (inwestycje, HYIP, zarobek) (`rss-mmgp-all`) | rss | mmgp.com | ru | 20 | 20 | 0 | 2026-11-21 |
| Habr — hub Криптография (`rss-habr-crypto`) | rss | habr.com | ru | 20 | 20 | 0 | 2026-11-20 |
| LowEndTalk — Requests (`rss-lowendtalk-requests`) | rss | lowendtalk.com | en | 20 | 20 | 0 | 2026-11-21 |
| Watcher Guru (Telegram @WatcherGuru) (`telegram-watcherguru`) | telegram | t.me/watcherguru | en | 14 | 14 | 0 | 2026-11-21 |
| GitHub Discussions — lightningnetwork/lnd (`rss-github-lnd-discussions`) | rss | github.com | en | 20 | 20 | 1 | 2026-11-17 |
| BitHub.pl (wpisy) (`rss-bithub-pl`) | rss | bithub.pl | pl | 12 | 12 | 0 | 2026-11-21 |
| CrypS.pl (wpisy) (`rss-cryps-pl`) | rss | cryps.pl | pl | 10 | 10 | 0 | 2026-11-21 |
| EEVblog Forum (`rss-eevblog`) | rss | eevblog.com | en | 5 | 0 | 0 | 2026-11-21 |
| Se7enSins — Crypto Currency (`rss-se7ensins-crypto`) | rss | se7ensins.com | en | 3 | 3 | 0 | 2026-10-11 |
| Carbonite — Virtual Currency Trades (`rss-carbonite-virtual-currency-trades`) | rss | carbonite.co.za | en | 20 | 20 | 0 | 2026-11-21 |
| Bitcointalk — Services (`btt-52`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2023-03-15 |
| WordPress.com — tag cryptocurrency (`rss-wordpresscom-cryptocurrency`) | rss | wordpress.com | en | 20 | 20 | 0 | 2026-11-21 |
| Forum-kredytowe.pl — Forum inwestycyjne (`rss-forum-kredytowe-inwestycyjne`) | rss | forum-kredytowe.pl | pl | 20 | 0 | 0 | 2026-08-03 |
| BitHub.pl (komentarze czytelników) (`rss-bithub-pl-komentarze`) | rss | bithub.pl | pl | 12 | 12 | 0 | 2026-02-11 |
| Forum PiO (optymalizacja.com) — ogłoszenia (`rss-pio-ogloszenia`) | rss | forum.optymalizacja.com | pl | 20 | 0 | 0 | 2026-05-19 |
| EEVblog Forum — Buy/Sell/Wanted (`rss-eevblog-buysellwanted`) | rss | eevblog.com | en | 5 | 0 | 0 | 2026-11-21 |
| c.im #kryptowaluty (`mastodon-tag-c-im-kryptowaluty`) | mastodon-tag | c.im | pl | 9 | 9 | 0 | 2026-11-15 |
| kolektiva.social #kryptowaluty (`mastodon-tag-kolektiva-social-kryptowaluty`) | mastodon-tag | kolektiva.social | pl | 2 | 2 | 0 | 2026-10-31 |
| Forum PiO (optymalizacja.com) — cała aktywność (`rss-pio-cala-aktywnosc`) | rss | forum.optymalizacja.com | pl | 20 | 0 | 0 | 2026-11-21 |
| social.vivaldi.net #kryptowaluty (`mastodon-tag-social-vivaldi-net-kryptowaluty`) | mastodon-tag | social.vivaldi.net | pl | 16 | 16 | 0 | 2026-11-18 |
| Forum-kredytowe.pl — cała aktywność (`rss-forum-kredytowe-cala-aktywnosc`) | rss | forum-kredytowe.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| CrypS.pl (komentarze czytelników) (`rss-cryps-pl-komentarze`) | rss | cryps.pl | pl | 10 | 10 | 0 | 2026-11-19 |
| Bitcoin Cash (BCH) – !bitcoincash@realbitcoin.cash (Lemmy) (`lemmy-realbitcoin-cash-bitcoincash`) | lemmy | realbitcoin.cash/c/bitcoincash | en | 20 | 20 | 0 | 2026-11-16 |
| Bitcoin Magazine (Telegram @BitcoinMagazineTelegram) (`telegram-bitcoinmagazinetelegram`) | telegram | t.me/bitcoinmagazinetelegram | en | 18 | 18 | 0 | 2026-11-20 |
| Bitcoin UK – !bitcoinuk@feddit.uk (Lemmy) (`lemmy-feddit-uk-bitcoinuk`) | lemmy | feddit.uk/c/bitcoinuk | en | 20 | 20 | 0 | 2023-08-03 |
| #bitcoin @ mstdn.jp (Mastodon) (`mastodon-tag-mstdn-jp-bitcoin`) | mastodon-tag | mstdn.jp | ja | 9 | 9 | 0 | 2026-11-21 |
| #bitcoin @ c.im (Mastodon) (`mastodon-tag-c-im-bitcoin`) | mastodon-tag | c.im | en | 17 | 17 | 0 | 2026-11-21 |
| Technology – !technology@programming.dev (Lemmy) (`lemmy-programming-dev-technology`) | lemmy | programming.dev/c/technology | en | 20 | 20 | 0 | 2026-10-13 |
| #bitcoin @ social.vivaldi.net (Mastodon) (`mastodon-tag-social-vivaldi-net-bitcoin`) | mastodon-tag | social.vivaldi.net | en | 17 | 17 | 0 | 2026-11-21 |
| #bitcoin @ kolektiva.social (Mastodon) (`mastodon-tag-kolektiva-social-bitcoin`) | mastodon-tag | kolektiva.social | en | 19 | 19 | 0 | 2026-11-21 |
| Bitcoin Core (BTC) – !btc@realbitcoin.cash (Lemmy) (`lemmy-realbitcoin-cash-btc`) | lemmy | realbitcoin.cash/c/btc | en | 20 | 20 | 0 | 2026-08-21 |
| Technology – !technology@beehaw.org (Lemmy) (`lemmy-beehaw-org-technology`) | lemmy | beehaw.org/c/technology | en | 20 | 20 | 0 | 2026-11-20 |
| Finance – !finance@thelemmy.club (Lemmy) (`lemmy-thelemmy-club-finance`) | lemmy | thelemmy.club/c/finance | en | 20 | 20 | 0 | 2026-11-21 |
| Personal Finance - UK – !personalfinanceuk@feddit.uk (Lemmy) (`lemmy-feddit-uk-personalfinanceuk`) | lemmy | feddit.uk/c/personalfinanceuk | en | 20 | 20 | 0 | 2026-11-18 |
| #crypto @ mstdn.jp (Mastodon) (`mastodon-tag-mstdn-jp-crypto`) | mastodon-tag | mstdn.jp | ja | 19 | 19 | 0 | 2026-11-21 |
| Privacy – !privacy@programming.dev (Lemmy) (`lemmy-programming-dev-privacy`) | lemmy | programming.dev/c/privacy | en | 20 | 20 | 0 | 2026-11-21 |
| Finance – !finance@beehaw.org (Lemmy) (`lemmy-beehaw-org-finance`) | lemmy | beehaw.org/c/finance | en | 20 | 20 | 0 | 2026-10-31 |
| Ethereum – !Ethereum@thelemmy.club (Lemmy) (`lemmy-thelemmy-club-ethereum`) | lemmy | thelemmy.club/c/ethereum | en | 13 | 13 | 0 | 2025-11-02 |
| CoinMarketCap Announcements (Telegram @CoinMarketCapAnnouncements) (`telegram-coinmarketcapannouncements`) | telegram | t.me/coinmarketcapannouncements | en | 11 | 11 | 0 | 2026-11-21 |
| Multiversx (forum, agora.multiversx.com) (`discourse-agora-multiversx-com`) | discourse | agora.multiversx.com | en | 20 | 20 | 0 | 2025-12-17 |
| Bitcointalk — Currency exchange (`btt-53`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2026-11-21 |
| Ethereum Magicians (forum) (`dsc-ethereum-magicians`) | discourse | ethereum-magicians.org | en | 20 | 20 | 0 | 2026-11-21 |
| bcharts (forum krypto/inwestycje, Brazylia) (`discourse-bcharts-com-br`) | discourse | bcharts.com.br | pt | 20 | 20 | 0 | 2026-11-21 |
| Ask Cryptography (askcryp.to) (`discourse-askcryp-to`) | discourse | askcryp.to | en | 20 | 20 | 0 | 2025-12-16 |
| Ethereum Research (ethresear.ch) (`dsc-ethresearch`) | discourse | ethresear.ch | en | 20 | 20 | 0 | 2026-11-20 |
| Delving Bitcoin (forum) (`dsc-delvingbitcoin`) | discourse | delvingbitcoin.org | en | 20 | 20 | 0 | 2026-11-21 |
| Bitcoin Cash Research (forum) (`discourse-bitcoincashresearch-org`) | discourse | bitcoincashresearch.org | en | 20 | 20 | 0 | 2026-11-21 |
| Chia Forum (chiaforum.com) (`discourse-chiaforum-com`) | discourse | chiaforum.com | en | 20 | 20 | 0 | 2026-11-02 |
| Bisq Community (giełda P2P) (`discourse-bisq-community`) | discourse | bisq.community | en | 20 | 20 | 3 | 2026-10-29 |
| Wu Blockchain News (Telegram @wublockchainenglish) (`telegram-wublockchainenglish`) | telegram | t.me/wublockchainenglish | en | 20 | 20 | 0 | 2026-11-21 |
| Baminvestor (społeczność, community.baminvestor.com) (`discourse-community-baminvestor-com`) | discourse | community.baminvestor.com | en | 14 | 14 | 0 | 2022-08-24 |
| Classic-agora (forum, classic-agora.terra.money) (`discourse-classic-agora-terra-money`) | discourse | classic-agora.terra.money | en | 20 | 20 | 0 | 2023-05-31 |
| Bitwarden (społeczność, community.bitwarden.com) (`discourse-community-bitwarden-com`) | discourse | community.bitwarden.com | en | 20 | 20 | 0 | 2026-11-21 |
| Agoric (społeczność, community.agoric.com) (`discourse-community-agoric-com`) | discourse | community.agoric.com | en | 20 | 20 | 0 | 2026-11-20 |
| Creditcoin (społeczność, community.creditcoin.org) (`discourse-community-creditcoin-org`) | discourse | community.creditcoin.org | en | 20 | 20 | 1 | 2026-02-28 |
| Brave (społeczność, community.brave.app) (`discourse-community-brave-app`) | discourse | community.brave.app | en | 20 | 20 | 0 | 2026-11-21 |
| Finary (społeczność, community.finary.com) (`discourse-community-finary-com`) | discourse | community.finary.com | fr | 20 | 20 | 0 | 2026-11-21 |
| Collective (forum, collective.flashbots.net) (`discourse-collective-flashbots-net`) | discourse | collective.flashbots.net | en | 20 | 20 | 0 | 2026-11-17 |
| Metamask (społeczność, community.metamask.com) (`discourse-community-metamask-com`) | discourse | community.metamask.com | en | 20 | 20 | 0 | 2026-11-21 |
| ForkLog (Telegram @forklog) (`telegram-forklog`) | telegram | t.me/forklog | ru | 19 | 19 | 0 | 2026-11-21 |
| Bitcointalk — Lending (`btt-65`) | smf-board | bitcointalk.org | en | 20 | 20 | 7 | 2018-09-27 |
| Monzo (społeczność, community.monzo.com) (`discourse-community-monzo-com`) | discourse | community.monzo.com | en | 20 | 20 | 0 | 2026-11-21 |
| Linea (społeczność, community.linea.build) (`discourse-community-linea-build`) | discourse | community.linea.build | en | 20 | 20 | 0 | 2026-02-26 |
| Lnbits (społeczność, community.lnbits.com) (`discourse-community-lnbits-com`) | discourse | community.lnbits.com | en | 20 | 20 | 0 | 2026-11-18 |
| Foundation (społeczność, community.foundation.xyz) (`discourse-community-foundation-xyz`) | discourse | community.foundation.xyz | en | 20 | 20 | 0 | 2026-11-21 |
| Iotex (społeczność, community.iotex.io) (`discourse-community-iotex-io`) | discourse | community.iotex.io | en | 20 | 20 | 3 | 2026-11-10 |
| Obol (społeczność, community.obol.org) (`discourse-community-obol-org`) | discourse | community.obol.org | en | 20 | 20 | 1 | 2026-10-07 |
| Nomadgate (społeczność, community.nomadgate.com) (`discourse-community-nomadgate-com`) | discourse | community.nomadgate.com | en | 20 | 20 | 0 | 2026-11-21 |
| Proptee (społeczność, community.proptee.io) (`discourse-community-proptee-io`) | discourse | community.proptee.io | en | 20 | 20 | 0 | 2025-09-25 |
| Incrypted (Telegram @incrypted) (`telegram-incrypted`) | telegram | t.me/incrypted | ru | 20 | 20 | 0 | 2026-11-21 |
| Reflexer (społeczność, community.reflexer.finance) (`discourse-community-reflexer-finance`) | discourse | community.reflexer.finance | en | 20 | 20 | 0 | 2025-12-16 |
| Radiant (społeczność, community.radiant.capital) (`discourse-community-radiant-capital`) | discourse | community.radiant.capital | en | 20 | 20 | 0 | 2026-11-20 |
| Okama (społeczność, community.okama.io) (`discourse-community-okama-io`) | discourse | community.okama.io | ru | 20 | 20 | 0 | 2026-11-11 |
| Starknet (społeczność, community.starknet.io) (`discourse-community-starknet-io`) | discourse | community.starknet.io | en | 20 | 20 | 0 | 2026-11-20 |
| Radworks (społeczność, community.radworks.org) (`discourse-community-radworks-org`) | discourse | community.radworks.org | en | 20 | 20 | 1 | 2026-11-21 |
| Signalusers (społeczność, community.signalusers.org) (`discourse-community-signalusers-org`) | discourse | community.signalusers.org | en | 20 | 20 | 0 | 2026-11-21 |
| Start9 (społeczność, community.start9.com) (`discourse-community-start9-com`) | discourse | community.start9.com | en | 20 | 20 | 0 | 2026-11-21 |
| Trading212 (społeczność, community.trading212.com) (`discourse-community-trading212-com`) | discourse | community.trading212.com | en | 20 | 20 | 0 | 2026-11-20 |
| Taiko (społeczność, community.taiko.xyz) (`discourse-community-taiko-xyz`) | discourse | community.taiko.xyz | en | 20 | 20 | 3 | 2026-01-28 |
| Upstox (społeczność, community.upstox.com) (`discourse-community-upstox-com`) | discourse | community.upstox.com | en | 20 | 20 | 0 | 2026-11-21 |
| BITS.MEDIA (Telegram @bitsmedia) (`telegram-bitsmedia`) | telegram | t.me/bitsmedia | ru | 15 | 15 | 0 | 2026-11-20 |
| Bitcointalk — Auctions (`btt-73`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2026-11-21 |
| Umbrel (społeczność, community.umbrel.com) (`discourse-community-umbrel-com`) | discourse | community.umbrel.com | en | 20 | 20 | 0 | 2026-11-20 |
| Tradovate (społeczność, community.tradovate.com) (`discourse-community-tradovate-com`) | discourse | community.tradovate.com | en | 20 | 20 | 0 | 2026-11-21 |
| Zama (społeczność, community.zama.org) (`discourse-community-zama-org`) | discourse | community.zama.org | en | 20 | 20 | 0 | 2026-11-21 |
| Venus (społeczność, community.venus.io) (`discourse-community-venus-io`) | discourse | community.venus.io | en | 20 | 20 | 0 | 2026-11-12 |
| Zoya (społeczność, community.zoya.finance) (`discourse-community-zoya-finance`) | discourse | community.zoya.finance | en | 3 | 3 | 0 | 2026-11-19 |
| Zkproof (społeczność, community.zkproof.org) (`discourse-community-zkproof-org`) | discourse | community.zkproof.org | en | 20 | 20 | 0 | 2026-10-07 |
| Compound (governance, www.comp.xyz) (`discourse-comp-xyz`) | discourse | comp.xyz | en | 20 | 20 | 0 | 2026-11-20 |
| Stafi (DAO, dao.stafi.io) (`discourse-dao-stafi-io`) | discourse | dao.stafi.io | en | 20 | 20 | 1 | 2026-10-12 |
| Aavegotchi (DAO, dao.aavegotchi.com) (`discourse-dao-aavegotchi-com`) | discourse | dao.aavegotchi.com | en | 20 | 20 | 0 | 2026-11-21 |
| Opencampus (DAO, dao.opencampus.xyz) (`discourse-dao-opencampus-xyz`) | discourse | dao.opencampus.xyz | en | 20 | 20 | 0 | 2026-08-04 |
| Alchemist (forum, discourse.alchemist.wtf) (`discourse-discourse-alchemist-wtf`) | discourse | discourse.alchemist.wtf | en | 20 | 20 | 0 | 2023-01-20 |
| РБК Крипто (Telegram @RBCCrypto) (`telegram-rbccrypto`) | telegram | t.me/rbccrypto | ru | 17 | 17 | 0 | 2026-11-21 |
| Beets (forum, discourse.beets.io) (`discourse-discourse-beets-io`) | discourse | discourse.beets.io | en | 20 | 20 | 0 | 2025-08-19 |
| Rocketpool (DAO, dao.rocketpool.net) (`discourse-dao-rocketpool-net`) | discourse | dao.rocketpool.net | en | 20 | 20 | 4 | 2026-11-19 |
| Bitdao (forum, discourse.bitdao.io) (`discourse-discourse-bitdao-io`) | discourse | discourse.bitdao.io | en | 20 | 20 | 0 | 2025-03-16 |
| Dappnode (forum, discourse.dappnode.io) (`discourse-discourse-dappnode-io`) | discourse | discourse.dappnode.io | en | 20 | 20 | 19 | 2026-11-16 |
| Teia (forum, discourse.teia.art) (`discourse-discourse-teia-art`) | discourse | discourse.teia.art | en | 20 | 20 | 0 | 2026-03-12 |
| Shadowsocks (forum, discourse.shadowsocks.org) (`discourse-discourse-shadowsocks-org`) | discourse | discourse.shadowsocks.org | en | 20 | 20 | 0 | 2026-11-15 |
| Xion (forum, discourse.xion.burnt.com) (`discourse-discourse-xion-burnt-com`) | discourse | discourse.xion.burnt.com | en | 20 | 20 | 0 | 2026-09-15 |
| Freedombox (forum, discuss.freedombox.org) (`discourse-discuss-freedombox-org`) | discourse | discuss.freedombox.org | en | 20 | 20 | 0 | 2026-11-21 |
| Gooddollar (forum, discourse.gooddollar.org) (`discourse-discourse-gooddollar-org`) | discourse | discourse.gooddollar.org | en | 20 | 20 | 1 | 2026-11-19 |
| Uma (forum, discourse.uma.xyz) (`discourse-discourse-uma-xyz`) | discourse | discourse.uma.xyz | en | 20 | 20 | 2 | 2026-11-21 |
| Nubits (forum, discuss.nubits.com) (`discourse-discuss-nubits-com`) | discourse | discuss.nubits.com | en | 3 | 3 | 0 | 2026-11-16 |
| Airdrop Official (Telegram @airdropofficial) (`telegram-airdropofficial`) | telegram | t.me/airdropofficial | en | 20 | 20 | 0 | 2026-11-21 |
| Bitcointalk — Scam Accusations (`btt-83`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2026-11-21 |
| Koinly (forum, discuss.koinly.io) (`discourse-discuss-koinly-io`) | discourse | discuss.koinly.io | en | 20 | 20 | 1 | 2026-11-20 |
| Jupiter (forum, discuss.jup.ag) (`discourse-discuss-jup-ag`) | discourse | discuss.jup.ag | en | 20 | 20 | 0 | 2026-09-21 |
| Libp2p (forum, discuss.libp2p.io) (`discourse-discuss-libp2p-io`) | discourse | discuss.libp2p.io | en | 20 | 20 | 0 | 2026-11-20 |
| Ipfs (forum, discuss.ipfs.tech) (`discourse-discuss-ipfs-tech`) | discourse | discuss.ipfs.tech | en | 20 | 20 | 0 | 2026-11-20 |
| Octant (forum, discuss.octant.app) (`discourse-discuss-octant-app`) | discourse | discuss.octant.app | en | 20 | 20 | 0 | 2026-02-04 |
| Ens (forum, discuss.ens.domains) (`discourse-discuss-ens-domains`) | discourse | discuss.ens.domains | en | 20 | 20 | 2 | 2026-11-21 |
| dYdX (governance, dydx.forum) (`discourse-dydx-forum`) | discourse | dydx.forum | en | 20 | 20 | 0 | 2026-11-19 |
| Driftgov (forum, driftgov.discourse.group) (`discourse-driftgov-discourse-group`) | discourse | driftgov.discourse.group | en | 20 | 20 | 0 | 2026-07-14 |
| Privacyguides (forum, discuss.privacyguides.net) (`discourse-discuss-privacyguides-net`) | discourse | discuss.privacyguides.net | en | 20 | 20 | 0 | 2026-11-21 |
| 0xprotocol (forum, forum.0xprotocol.org) (`discourse-forum-0xprotocol-org`) | discourse | forum.0xprotocol.org | en | 20 | 20 | 0 | 2025-11-26 |
| Ergo (forum, ergoforum.org) (`discourse-ergoforum-org`) | discourse | ergoforum.org | en | 20 | 20 | 0 | 2026-11-21 |
| Airdrop Detective (Telegram @AirdropDetective) (`telegram-airdropdetective`) | telegram | t.me/airdropdetective | en | 20 | 20 | 0 | 2026-11-20 |
| Across (forum, forum.across.to) (`discourse-forum-across-to`) | discourse | forum.across.to | en | 20 | 20 | 0 | 2026-09-17 |
| Ajna (forum, forum.ajna.finance) (`discourse-forum-ajna-finance`) | discourse | forum.ajna.finance | en | 20 | 20 | 8 | 2026-03-07 |
| Aeternity (forum, forum.aeternity.com) (`discourse-forum-aeternity-com`) | discourse | forum.aeternity.com | en | 20 | 20 | 0 | 2026-10-18 |
| Alpaca (forum, forum.alpaca.markets) (`discourse-forum-alpaca-markets`) | discourse | forum.alpaca.markets | en | 20 | 20 | 0 | 2026-11-20 |
| Aladdin (forum, forum.aladdin.club) (`discourse-forum-aladdin-club`) | discourse | forum.aladdin.club | en | 20 | 20 | 4 | 2026-11-14 |
| Ampleforth (forum, forum.ampleforth.org) (`discourse-forum-ampleforth-org`) | discourse | forum.ampleforth.org | en | 20 | 20 | 0 | 2026-11-18 |
| Arcium (forum, forum.arcium.com) (`discourse-forum-arcium-com`) | discourse | forum.arcium.com | en | 10 | 10 | 0 | 2026-11-02 |
| Anoma (forum, forum.anoma.net) (`discourse-forum-anoma-net`) | discourse | forum.anoma.net | en | 20 | 20 | 1 | 2026-11-18 |
| Anchorprotocol (forum, forum.anchorprotocol.com) (`discourse-forum-anchorprotocol-com`) | discourse | forum.anchorprotocol.com | en | 20 | 20 | 0 | 2023-08-22 |
| Aurora (forum, forum.aurora.dev) (`discourse-forum-aurora-dev`) | discourse | forum.aurora.dev | en | 20 | 20 | 0 | 2026-11-18 |
| Availproject (forum, forum.availproject.org) (`discourse-forum-availproject-org`) | discourse | forum.availproject.org | en | 20 | 20 | 0 | 2026-11-20 |
| Arbitrum (forum, forum.arbitrum.foundation) (`discourse-forum-arbitrum-foundation`) | discourse | forum.arbitrum.foundation | en | 20 | 20 | 0 | 2026-11-20 |
| AIRDROPS.IO 🚀 (Telegram @airdrops_io) (`telegram-airdrops-io`) | telegram | t.me/airdrops_io | en | 20 | 20 | 0 | 2026-11-20 |
| Autonomys (forum, forum.autonomys.xyz) (`discourse-forum-autonomys-xyz`) | discourse | forum.autonomys.xyz | en | 20 | 20 | 1 | 2026-11-21 |
| Bitcointalk — Reputation (`btt-129`) | smf-board | bitcointalk.org | en | 20 | 20 | 1 | 2026-11-21 |
| Astar (forum, forum.astar.network) (`discourse-forum-astar-network`) | discourse | forum.astar.network | en | 20 | 20 | 0 | 2026-11-17 |
| Aztec (forum, forum.aztec.network) (`discourse-forum-aztec-network`) | discourse | forum.aztec.network | en | 20 | 20 | 8 | 2026-11-19 |
| Babylon (forum, forum.babylon.foundation) (`discourse-forum-babylon-foundation`) | discourse | forum.babylon.foundation | en | 20 | 20 | 2 | 2026-11-17 |
| Badger (forum, forum.badger.finance) (`discourse-forum-badger-finance`) | discourse | forum.badger.finance | en | 20 | 20 | 0 | 2026-11-20 |
| Balancer (forum, forum.balancer.fi) (`discourse-forum-balancer-fi`) | discourse | forum.balancer.fi | en | 20 | 20 | 2 | 2026-11-11 |
| Ascendedtrading (forum, forum.ascendedtrading.com) (`discourse-forum-ascendedtrading-com`) | discourse | forum.ascendedtrading.com | en | 20 | 20 | 0 | 2026-11-20 |
| Bitcoinunlimited (forum, forum.bitcoinunlimited.info) (`discourse-forum-bitcoinunlimited-info`) | discourse | forum.bitcoinunlimited.info | en | 20 | 20 | 1 | 2026-11-21 |
| Berachain (forum, forum.berachain.com) (`discourse-forum-berachain-com`) | discourse | forum.berachain.com | en | 20 | 20 | 6 | 2026-06-07 |
| ICO Drops - ICO News & Alerts (Telegram @icodrops) (`telegram-icodrops`) | telegram | t.me/icodrops | en | 20 | 20 | 0 | 2026-11-21 |
| Blocktrainer (forum, forum.blocktrainer.de) (`discourse-forum-blocktrainer-de`) | discourse | forum.blocktrainer.de | de | 20 | 20 | 0 | 2026-11-21 |
| Bandprotocol (forum, forum.bandprotocol.com) (`discourse-forum-bandprotocol-com`) | discourse | forum.bandprotocol.com | en | 20 | 20 | 0 | 2026-11-08 |
| Boba (forum, forum.boba.network) (`discourse-forum-boba-network`) | discourse | forum.boba.network | en | 20 | 20 | 0 | 2024-03-18 |
| Bnbchain (forum, forum.bnbchain.org) (`discourse-forum-bnbchain-org`) | discourse | forum.bnbchain.org | en | 20 | 20 | 2 | 2026-11-20 |
| Canton Network / Daml (forum) (`discourse-forum-canton-network`) | discourse | forum.canton.network | en | 20 | 20 | 0 | 2026-11-21 |
| Casper (forum, forum.casper.network) (`discourse-forum-casper-network`) | discourse | forum.casper.network | en | 20 | 20 | 0 | 2026-06-24 |
| Cardano (forum, forum.cardano.org) (`discourse-forum-cardano-org`) | discourse | forum.cardano.org | en | 20 | 20 | 0 | 2026-11-21 |
| Citrea (forum, forum.citrea.xyz) (`discourse-forum-citrea-xyz`) | discourse | forum.citrea.xyz | en | 11 | 11 | 1 | 2026-07-01 |
| Celer (forum, forum.celer.network) (`discourse-forum-celer-network`) | discourse | forum.celer.network | en | 13 | 13 | 0 | 2026-11-08 |
| Celestia (forum, forum.celestia.org) (`discourse-forum-celestia-org`) | discourse | forum.celestia.org | en | 20 | 20 | 0 | 2026-11-16 |
| Notcoin Community (Telegram @notcoin) (`telegram-notcoin`) | telegram | t.me/notcoin | en | 16 | 16 | 0 | 2026-11-09 |
| Celo (forum, forum.celo.org) (`discourse-forum-celo-org`) | discourse | forum.celo.org | en | 20 | 20 | 1 | 2026-11-20 |
| Concordium (forum, forum.concordium.com) (`discourse-forum-concordium-com`) | discourse | forum.concordium.com | en | 20 | 20 | 0 | 2026-11-11 |
| Bitcointalk — Bitcoin Discussion (`btt-1`) | smf-board | bitcointalk.org | en | 20 | 20 | 0 | 2026-11-21 |
| Metis CEG (governance, forum.ceg.vote) (`discourse-forum-ceg-vote`) | discourse | forum.ceg.vote | en | 20 | 20 | 1 | 2026-11-20 |
| Conflux (forum, forum.conflux.fun) (`discourse-forum-conflux-fun`) | discourse | forum.conflux.fun | zh | 20 | 20 | 0 | 2026-11-21 |
| Cow (forum, forum.cow.fi) (`discourse-forum-cow-fi`) | discourse | forum.cow.fi | en | 20 | 20 | 2 | 2026-11-20 |
| Decentraland (forum, forum.decentraland.org) (`discourse-forum-decentraland-org`) | discourse | forum.decentraland.org | en | 20 | 20 | 0 | 2026-11-21 |
| Cosmos (forum, forum.cosmos.network) (`discourse-forum-cosmos-network`) | discourse | forum.cosmos.network | en | 20 | 20 | 0 | 2026-11-21 |
| Cryptex (forum, forum.cryptex.finance) (`discourse-forum-cryptex-finance`) | discourse | forum.cryptex.finance | en | 20 | 20 | 2 | 2026-11-08 |
| Duniter (forum, forum.duniter.org) (`discourse-forum-duniter-org`) | discourse | forum.duniter.org | fr | 20 | 20 | 0 | 2026-11-21 |
| Dymension (forum, forum.dymension.xyz) (`discourse-forum-dymension-xyz`) | discourse | forum.dymension.xyz | en | 20 | 20 | 0 | 2026-10-06 |
| Devcon (forum, forum.devcon.org) (`discourse-forum-devcon-org`) | discourse | forum.devcon.org | en | 20 | 20 | 0 | 2026-11-21 |
| Dfinity (forum, forum.dfinity.org) (`discourse-forum-dfinity-org`) | discourse | forum.dfinity.org | en | 20 | 20 | 0 | 2026-11-21 |
| Developerdao (forum, forum.developerdao.com) (`discourse-forum-developerdao-com`) | discourse | forum.developerdao.com | en | 20 | 20 | 0 | 2026-11-11 |
| Hamster Kombat Announcement (Telegram @hamster_kombat) (`telegram-hamster-kombat`) | telegram | t.me/hamster_kombat | en | 18 | 18 | 0 | 2026-01-20 |
| Encointer (forum, forum.encointer.org) (`discourse-forum-encointer-org`) | discourse | forum.encointer.org | en | 20 | 20 | 0 | 2026-01-04 |
| L2BEAT (governance, forum.ethbeat.org) (`discourse-forum-ethbeat-org`) | discourse | forum.ethbeat.org | en | 20 | 20 | 4 | 2026-11-20 |
| Eigenlayer (forum, forum.eigenlayer.xyz) (`discourse-forum-eigenlayer-xyz`) | discourse | forum.eigenlayer.xyz | en | 20 | 20 | 3 | 2026-11-06 |
| Dhedge (forum, forum.dhedge.org) (`discourse-forum-dhedge-org`) | discourse | forum.dhedge.org | en | 20 | 20 | 0 | 2025-10-16 |
| Firo (forum, forum.firo.org) (`discourse-forum-firo-org`) | discourse | forum.firo.org | en | 20 | 20 | 0 | 2026-11-20 |
| Ethichub (forum, forum.ethichub.com) (`discourse-forum-ethichub-com`) | discourse | forum.ethichub.com | en | 20 | 20 | 0 | 2026-06-09 |
| Elysia (forum, forum.elysia.land) (`discourse-forum-elysia-land`) | discourse | forum.elysia.land | en | 10 | 10 | 0 | 2023-04-14 |
| Euler (forum, forum.euler.finance) (`discourse-forum-euler-finance`) | discourse | forum.euler.finance | en | 20 | 20 | 7 | 2026-11-14 |
| Flare (forum, forum.flare.network) (`discourse-forum-flare-network`) | discourse | forum.flare.network | en | 20 | 20 | 2 | 2026-11-20 |
| F-droid (forum, forum.f-droid.org) (`discourse-forum-f-droid-org`) | discourse | forum.f-droid.org | en | 20 | 20 | 0 | 2026-11-21 |
| Fluxfinance (forum, forum.fluxfinance.com) (`discourse-forum-fluxfinance-com`) | discourse | forum.fluxfinance.com | en | 20 | 20 | 1 | 2026-11-19 |
| DOGS Community (Telegram @dogs_community) (`telegram-dogs-community`) | telegram | t.me/dogs_community | en | 20 | 20 | 0 | 2026-11-19 |
| Flow (forum, forum.flow.com) (`discourse-forum-flow-com`) | discourse | forum.flow.com | en | 20 | 20 | 0 | 2026-11-17 |
| Bitcointalk — Bounties (Altcoins) (`btt-238`) | smf-board | bitcointalk.org | en | 20 | 20 | 9 | 2026-01-13 |
| Fuse (forum, forum.fuse.io) (`discourse-forum-fuse-io`) | discourse | forum.fuse.io | en | 20 | 20 | 0 | 2026-11-03 |
| Gitopia (forum, forum.gitopia.com) (`discourse-forum-gitopia-com`) | discourse | forum.gitopia.com | en | 5 | 5 | 0 | 2025-07-03 |
| Folks (forum, forum.folks.finance) (`discourse-forum-folks-finance`) | discourse | forum.folks.finance | en | 20 | 20 | 0 | 2026-11-21 |
| Fuel (forum, forum.fuel.network) (`discourse-forum-fuel-network`) | discourse | forum.fuel.network | en | 20 | 20 | 0 | 2026-08-04 |
| Gobob (forum, forum.gobob.xyz) (`discourse-forum-gobob-xyz`) | discourse | forum.gobob.xyz | en | 20 | 20 | 0 | 2026-08-29 |
| Giveth (forum, forum.giveth.io) (`discourse-forum-giveth-io`) | discourse | forum.giveth.io | en | 20 | 20 | 0 | 2026-11-20 |
| Gnosis (forum, forum.gnosis.io) (`discourse-forum-gnosis-io`) | discourse | forum.gnosis.io | en | 20 | 20 | 3 | 2026-11-20 |
| Gravity (forum, forum.gravity.xyz) (`discourse-forum-gravity-xyz`) | discourse | forum.gravity.xyz | en | 20 | 20 | 2 | 2026-10-24 |
| Grin (forum, forum.grin.mw) (`discourse-forum-grin-mw`) | discourse | forum.grin.mw | en | 20 | 20 | 0 | 2026-11-21 |
| Blum: All Crypto – One App (Telegram @blumcrypto) (`telegram-blumcrypto`) | telegram | t.me/blumcrypto | en | 19 | 19 | 0 | 2026-11-20 |
| Icon (forum, forum.icon.community) (`discourse-forum-icon-community`) | discourse | forum.icon.community | en | 20 | 20 | 1 | 2026-11-10 |
| Hifi (forum, forum.hifi.finance) (`discourse-forum-hifi-finance`) | discourse | forum.hifi.finance | en | 20 | 20 | 0 | 2026-07-19 |
| Initia (forum, forum.initia.xyz) (`discourse-forum-initia-xyz`) | discourse | forum.initia.xyz | en | 20 | 20 | 2 | 2026-11-17 |
| Hypercore (forum, forum.hypercore.one) (`discourse-forum-hypercore-one`) | discourse | forum.hypercore.one | en | 20 | 20 | 0 | 2026-11-19 |
| Inverse (forum, forum.inverse.finance) (`discourse-forum-inverse-finance`) | discourse | forum.inverse.finance | en | 20 | 20 | 8 | 2026-11-19 |
| Irisnet (forum, forum.irisnet.org) (`discourse-forum-irisnet-org`) | discourse | forum.irisnet.org | en | 20 | 20 | 0 | 2026-02-11 |
| JUST / TRON DeFi (governance, forum.just.network) (`discourse-forum-just-network`) | discourse | forum.just.network | en | 20 | 20 | 0 | 2026-11-14 |
| Jito (forum, forum.jito.network) (`discourse-forum-jito-network`) | discourse | forum.jito.network | en | 20 | 20 | 0 | 2026-10-27 |
| Crypto Bot News (Telegram @CryptoBotEN) (`telegram-cryptoboten`) | telegram | t.me/cryptoboten | en | 20 | 20 | 0 | 2026-11-06 |
| Lexpunk (forum, forum.lexpunk.army) (`discourse-forum-lexpunk-army`) | discourse | forum.lexpunk.army | en | 6 | 6 | 0 | 2023-07-20 |
| Kryptex (forum, forum.kryptex.com) (`discourse-forum-kryptex-com`) | discourse | forum.kryptex.com | ru | 20 | 20 | 0 | 2026-11-21 |
| Bitcointalk — Marketplace (Altcoins) (`btt-161`) | smf-board | bitcointalk.org | en | 20 | 20 | 1 | 2025-05-17 |
| Latticex (forum, forum.latticex.foundation) (`discourse-forum-latticex-foundation`) | discourse | forum.latticex.foundation | zh | 20 | 20 | 0 | 2026-04-26 |
| Indigoprotocol (forum, forum.indigoprotocol.io) (`discourse-forum-indigoprotocol-io`) | discourse | forum.indigoprotocol.io | en | 20 | 20 | 0 | 2026-07-18 |
| Liberland (forum, forum.liberland.org) (`discourse-forum-liberland-org`) | discourse | forum.liberland.org | en | 20 | 20 | 0 | 2026-11-19 |
| Kleros (forum, forum.kleros.io) (`discourse-forum-kleros-io`) | discourse | forum.kleros.io | en | 20 | 20 | 1 | 2026-11-19 |
| Mantle (forum, forum.mantle.xyz) (`discourse-forum-mantle-xyz`) | discourse | forum.mantle.xyz | en | 20 | 20 | 0 | 2026-11-19 |
| Livepeer (forum, forum.livepeer.org) (`discourse-forum-livepeer-org`) | discourse | forum.livepeer.org | en | 20 | 20 | 1 | 2026-11-19 |
| Marinade (forum, forum.marinade.finance) (`discourse-forum-marinade-finance`) | discourse | forum.marinade.finance | en | 20 | 20 | 0 | 2026-11-20 |
| Manifold (forum, forum.manifold.xyz) (`discourse-forum-manifold-xyz`) | discourse | forum.manifold.xyz | en | 20 | 20 | 0 | 2026-11-19 |
| Mapprotocol (forum, forum.mapprotocol.io) (`discourse-forum-mapprotocol-io`) | discourse | forum.mapprotocol.io | en | 6 | 6 | 0 | 2026-11-19 |
| Lxdao (forum, forum.lxdao.io) (`discourse-forum-lxdao-io`) | discourse | forum.lxdao.io | zh | 20 | 20 | 0 | 2026-11-21 |
| Новости Crypto Bot (Telegram @CryptoBotRU) (`telegram-cryptobotru`) | telegram | t.me/cryptobotru | ru | 20 | 20 | 0 | 2026-11-18 |
| Mento (forum, forum.mento.org) (`discourse-forum-mento-org`) | discourse | forum.mento.org | en | 20 | 20 | 2 | 2026-08-21 |
| Midnight (forum, forum.midnight.network) (`discourse-forum-midnight-network`) | discourse | forum.midnight.network | en | 20 | 20 | 0 | 2026-11-20 |
| Minswap (forum, forum.minswap.org) (`discourse-forum-minswap-org`) | discourse | forum.minswap.org | en | 20 | 20 | 0 | 2026-10-07 |
| Monero (forum, forum.monero.space) (`discourse-forum-monero-space`) | discourse | forum.monero.space | en | 20 | 20 | 0 | 2026-11-20 |
| Monad (forum, forum.monad.xyz) (`discourse-forum-monad-xyz`) | discourse | forum.monad.xyz | en | 20 | 20 | 0 | 2026-11-20 |
| Namada (forum, forum.namada.net) (`discourse-forum-namada-net`) | discourse | forum.namada.net | en | 20 | 20 | 0 | 2026-11-18 |
| Moonwell (forum, forum.moonwell.fi) (`discourse-forum-moonwell-fi`) | discourse | forum.moonwell.fi | en | 20 | 20 | 2 | 2026-11-20 |
| Morpho (forum, forum.morpho.org) (`discourse-forum-morpho-org`) | discourse | forum.morpho.org | en | 20 | 20 | 2 | 2026-11-20 |
| Mustachianpost (forum, forum.mustachianpost.com) (`discourse-forum-mustachianpost-com`) | discourse | forum.mustachianpost.com | en | 20 | 20 | 0 | 2026-11-21 |
| Nem (forum, forum.nem.io) (`discourse-forum-nem-io`) | discourse | forum.nem.io | en | 20 | 20 | 0 | 2021-10-12 |
| Nexusmutual (forum, forum.nexusmutual.io) (`discourse-forum-nexusmutual-io`) | discourse | forum.nexusmutual.io | en | 20 | 20 | 0 | 2026-11-13 |
| Mwc (forum, forum.mwc.mw) (`discourse-forum-mwc-mw`) | discourse | forum.mwc.mw | en | 20 | 20 | 0 | 2022-11-04 |
| Nftx (forum, forum.nftx.org) (`discourse-forum-nftx-org`) | discourse | forum.nftx.org | en | 20 | 20 | 3 | 2024-12-04 |
| Bitcointalk — Deutsch — Marktplatz (`btt-269`) | smf-board | bitcointalk.org | de | 20 | 20 | 0 | 2026-11-13 |
| Keeper News (Telegram @tonkeeper_news) (`telegram-tonkeeper-news`) | telegram | t.me/tonkeeper_news | en | 20 | 20 | 0 | 2026-11-19 |
| Notional (forum, forum.notional.finance) (`discourse-forum-notional-finance`) | discourse | forum.notional.finance | en | 20 | 20 | 1 | 2025-05-14 |
| Nkn (forum, forum.nkn.org) (`discourse-forum-nkn-org`) | discourse | forum.nkn.org | en | 20 | 20 | 0 | 2026-10-08 |
| Numer (forum, forum.numer.ai) (`discourse-forum-numer-ai`) | discourse | forum.numer.ai | en | 20 | 20 | 0 | 2026-11-20 |
| Nexa (forum, forum.nexa.org) (`discourse-forum-nexa-org`) | discourse | forum.nexa.org | en | 20 | 20 | 0 | 2026-11-19 |
| Nym (forum, forum.nym.com) (`discourse-forum-nym-com`) | discourse | forum.nym.com | en | 20 | 20 | 0 | 2026-11-21 |
| Pancakeswap (forum, forum.pancakeswap.finance) (`discourse-forum-pancakeswap-finance`) | discourse | forum.pancakeswap.finance | en | 20 | 20 | 4 | 2026-11-10 |
| Ohmydollar (forum, forum.ohmydollar.com) (`discourse-forum-ohmydollar-com`) | discourse | forum.ohmydollar.com | en | 20 | 20 | 0 | 2026-11-21 |
| Openwrt (forum, forum.openwrt.org) (`discourse-forum-openwrt-org`) | discourse | forum.openwrt.org | en | 20 | 20 | 0 | 2026-11-21 |
| Openzeppelin (forum, forum.openzeppelin.com) (`discourse-forum-openzeppelin-com`) | discourse | forum.openzeppelin.com | en | 20 | 20 | 0 | 2026-11-06 |
| Persistence (forum, forum.persistence.one) (`discourse-forum-persistence-one`) | discourse | forum.persistence.one | en | 20 | 20 | 1 | 2026-07-04 |
| Osmosis (forum, forum.osmosis.zone) (`discourse-forum-osmosis-zone`) | discourse | forum.osmosis.zone | en | 20 | 20 | 0 | 2026-11-20 |
| Getgems NFT (Telegram @getgems) (`telegram-getgems`) | telegram | t.me/getgems | en | 15 | 15 | 0 | 2026-11-13 |
| Phala (forum, forum.phala.network) (`discourse-forum-phala-network`) | discourse | forum.phala.network | en | 20 | 20 | 1 | 2026-06-10 |
| Pokt (forum, forum.pokt.network) (`discourse-forum-pokt-network`) | discourse | forum.pokt.network | en | 20 | 20 | 0 | 2026-10-11 |
| Polkadot (forum, forum.polkadot.network) (`discourse-forum-polkadot-network`) | discourse | forum.polkadot.network | en | 20 | 20 | 0 | 2026-11-20 |
| Premia (forum, forum.premia.finance) (`discourse-forum-premia-finance`) | discourse | forum.premia.finance | en | 20 | 20 | 1 | 2024-05-16 |
| Portfolio-performance (forum, forum.portfolio-performance.info) (`discourse-forum-portfolio-performance-info`) | discourse | forum.portfolio-performance.info | en | 20 | 20 | 0 | 2026-11-21 |
| Polygon (forum, forum.polygon.technology) (`discourse-forum-polygon-technology`) | discourse | forum.polygon.technology | en | 20 | 20 | 1 | 2026-11-20 |
| Qubes-os (forum, forum.qubes-os.org) (`discourse-forum-qubes-os-org`) | discourse | forum.qubes-os.org | en | 20 | 20 | 0 | 2026-11-21 |
| Pyth (forum, forum.pyth.network) (`discourse-forum-pyth-network`) | discourse | forum.pyth.network | en | 20 | 20 | 10 | 2026-11-20 |
| Pstake (forum, forum.pstake.finance) (`discourse-forum-pstake-finance`) | discourse | forum.pstake.finance | en | 20 | 20 | 1 | 2025-01-18 |
| Reserve (forum, forum.reserve.org) (`discourse-forum-reserve-org`) | discourse | forum.reserve.org | en | 20 | 20 | 5 | 2026-11-21 |
| BNB Chain (Telegram @bnbchain) (`telegram-bnbchain`) | telegram | t.me/bnbchain | en | 18 | 18 | 0 | 2026-11-19 |
| Safe (governance, forum.safefoundation.org) (`discourse-forum-safefoundation-org`) | discourse | forum.safefoundation.org | en | 20 | 20 | 0 | 2026-11-21 |
| Regen (forum, forum.regen.network) (`discourse-forum-regen-network`) | discourse | forum.regen.network | en | 20 | 20 | 0 | 2026-11-19 |
| Rubyonrails (forum, forum.rubyonrails.pl) (`discourse-forum-rubyonrails-pl`) | discourse | forum.rubyonrails.pl | pl | 20 | 20 | 0 | 2026-11-07 |
| SuperRare / RARE (governance, forum.rare.xyz) (`discourse-forum-rare-xyz`) | discourse | forum.rare.xyz | en | 20 | 20 | 1 | 2026-09-18 |
| Bitcointalk — Русский (Russian) (`btt-10`) | smf-board | bitcointalk.org | ru | 20 | 20 | 0 | 2019-02-06 |
| Shapeshift (forum, forum.shapeshift.com) (`discourse-forum-shapeshift-com`) | discourse | forum.shapeshift.com | en | 20 | 20 | 1 | 2026-11-12 |
| Sia (forum, forum.sia.tech) (`discourse-forum-sia-tech`) | discourse | forum.sia.tech | en | 20 | 20 | 0 | 2026-11-11 |
| Scroll (forum, forum.scroll.io) (`discourse-forum-scroll-io`) | discourse | forum.scroll.io | en | 20 | 20 | 3 | 2026-11-11 |
| Scrt (forum, forum.scrt.network) (`discourse-forum-scrt-network`) | discourse | forum.scrt.network | en | 20 | 20 | 0 | 2026-10-01 |
| Safex (forum, forum.safex.org) (`discourse-forum-safex-org`) | discourse | forum.safex.org | en | 20 | 20 | 0 | 2026-11-20 |
| Skale (forum, forum.skale.network) (`discourse-forum-skale-network`) | discourse | forum.skale.network | en | 20 | 20 | 0 | 2026-10-04 |
| Sovryn (forum, forum.sovryn.com) (`discourse-forum-sovryn-com`) | discourse | forum.sovryn.com | en | 20 | 20 | 3 | 2026-11-10 |
| Sky / MakerDAO (governance, forum.skyeco.com) (`discourse-forum-skyeco-com`) | discourse | forum.skyeco.com | en | 20 | 20 | 6 | 2026-11-21 |
| EXMO.com Official (Telegram @exmo_official) (`telegram-exmo-official`) | telegram | t.me/exmo_official | en | 20 | 20 | 0 | 2026-10-27 |
| Solana (forum, forum.solana.com) (`discourse-forum-solana-com`) | discourse | forum.solana.com | en | 20 | 20 | 0 | 2026-11-19 |
| Soliditylang (forum, forum.soliditylang.org) (`discourse-forum-soliditylang-org`) | discourse | forum.soliditylang.org | en | 20 | 20 | 0 | 2026-11-19 |
| Ssv (forum, forum.ssv.network) (`discourse-forum-ssv-network`) | discourse | forum.ssv.network | en | 20 | 20 | 2 | 2026-11-21 |
| Sporkdao (forum, forum.sporkdao.org) (`discourse-forum-sporkdao-org`) | discourse | forum.sporkdao.org | en | 14 | 14 | 0 | 2024-09-23 |
| Stakewise (forum, forum.stakewise.io) (`discourse-forum-stakewise-io`) | discourse | forum.stakewise.io | en | 20 | 20 | 4 | 2026-11-20 |
| Storj (forum, forum.storj.io) (`discourse-forum-storj-io`) | discourse | forum.storj.io | en | 20 | 20 | 0 | 2026-11-21 |
| Superfluid (forum, forum.superfluid.org) (`discourse-forum-superfluid-org`) | discourse | forum.superfluid.org | en | 20 | 20 | 1 | 2026-10-08 |
| Stacks (forum, forum.stacks.org) (`discourse-forum-stacks-org`) | discourse | forum.stacks.org | en | 20 | 20 | 0 | 2026-11-21 |
| unfolded. (Telegram @unfolded) (`telegram-unfolded`) | telegram | t.me/unfolded | en | 20 | 20 | 0 | 2026-11-20 |
| Summer (forum, forum.summer.fi) (`discourse-forum-summer-fi`) | discourse | forum.summer.fi | en | 20 | 20 | 6 | 2026-11-20 |
| Sundaeswap (forum, forum.sundaeswap.finance) (`discourse-forum-sundaeswap-finance`) | discourse | forum.sundaeswap.finance | en | 20 | 20 | 0 | 2026-09-12 |
| Bitcointalk — Español — Mercadillo (`btt-101`) | smf-board | bitcointalk.org | es | 20 | 20 | 0 | 2026-11-21 |
| Threshold (forum, forum.threshold.network) (`discourse-forum-threshold-network`) | discourse | forum.threshold.network | en | 20 | 20 | 3 | 2026-11-18 |
| Tokenlon (forum, forum.tokenlon.im) (`discourse-forum-tokenlon-im`) | discourse | forum.tokenlon.im | zh | 20 | 20 | 1 | 2023-06-13 |
| Thegraph (forum, forum.thegraph.com) (`discourse-forum-thegraph-com`) | discourse | forum.thegraph.com | en | 20 | 20 | 0 | 2026-11-21 |
| Stocks (forum, forum.stocks.cafe) (`discourse-forum-stocks-cafe`) | discourse | forum.stocks.cafe | en | 20 | 20 | 0 | 2026-11-21 |
| Torproject (forum, forum.torproject.org) (`discourse-forum-torproject-org`) | discourse | forum.torproject.org | en | 20 | 20 | 0 | 2026-11-21 |
| Tezosagora (forum, forum.tezosagora.org) (`discourse-forum-tezosagora-org`) | discourse | forum.tezosagora.org | en | 20 | 20 | 0 | 2026-11-20 |
| Untangled (forum, forum.untangled.finance) (`discourse-forum-untangled-finance`) | discourse | forum.untangled.finance | en | 10 | 10 | 0 | 2026-10-29 |
| Bitcoin (Telegram @bitcoin) (`telegram-bitcoin`) | telegram | t.me/bitcoin | en | 20 | 20 | 0 | 2026-11-21 |
| Unore (forum, forum.unore.io) (`discourse-forum-unore-io`) | discourse | forum.unore.io | en | 20 | 20 | 0 | 2025-08-13 |
| Unofficed (forum, forum.unofficed.com) (`discourse-forum-unofficed-com`) | discourse | forum.unofficed.com | en | 20 | 20 | 0 | 2026-11-20 |
| Truefi (forum, forum.truefi.io) (`discourse-forum-truefi-io`) | discourse | forum.truefi.io | en | 20 | 20 | 1 | 2026-11-10 |
| Treasure (forum, forum.treasure.lol) (`discourse-forum-treasure-lol`) | discourse | forum.treasure.lol | en | 20 | 20 | 0 | 2026-11-12 |
| Trondao (forum, forum.trondao.org) (`discourse-forum-trondao-org`) | discourse | forum.trondao.org | en | 20 | 20 | 1 | 2026-11-21 |
| Youves (forum, forum.youves.com) (`discourse-forum-youves-com`) | discourse | forum.youves.com | en | 20 | 20 | 0 | 2026-04-24 |
| Usual (forum, forum.usual.money) (`discourse-forum-usual-money`) | discourse | forum.usual.money | en | 20 | 20 | 0 | 2026-11-16 |
| Waves (forum, forum.waves.tech) (`discourse-forum-waves-tech`) | discourse | forum.waves.tech | en | 20 | 20 | 0 | 2026-11-20 |
| Vwbl-protocol (forum, forum.vwbl-protocol.org) (`discourse-forum-vwbl-protocol-org`) | discourse | forum.vwbl-protocol.org | ja | 6 | 6 | 0 | 2024-02-05 |
| Yunohost (forum, forum.yunohost.org) (`discourse-forum-yunohost-org`) | discourse | forum.yunohost.org | en | 20 | 20 | 0 | 2026-11-21 |
| @crypto (Telegram @crypto) (`telegram-crypto`) | telegram | t.me/crypto | en | 11 | 11 | 0 | 2026-11-21 |
| Zenon (forum, forum.zenon.org) (`discourse-forum-zenon-org`) | discourse | forum.zenon.org | en | 20 | 20 | 0 | 2026-11-13 |
| Zcashcommunity (forum, forum.zcashcommunity.com) (`discourse-forum-zcashcommunity-com`) | discourse | forum.zcashcommunity.com | en | 20 | 20 | 0 | 2026-11-21 |
| Xx (forum, forum.xx.network) (`discourse-forum-xx-network`) | discourse | forum.xx.network | en | 20 | 20 | 0 | 2026-11-16 |
| Kicksecure (forum, forums.kicksecure.com) (`discourse-forums-kicksecure-com`) | discourse | forums.kicksecure.com | en | 20 | 20 | 0 | 2026-11-20 |
| Zknation (forum, forum.zknation.io) (`discourse-forum-zknation-io`) | discourse | forum.zknation.io | en | 20 | 20 | 0 | 2026-11-13 |
| Sui (forum, forums.sui.io) (`discourse-forums-sui-io`) | discourse | forums.sui.io | en | 20 | 20 | 0 | 2026-11-20 |
| Whonix (forum, forums.whonix.org) (`discourse-forums-whonix-org`) | discourse | forums.whonix.org | en | 20 | 20 | 0 | 2026-11-21 |
| Derive (forum, forums.derive.xyz) (`discourse-forums-derive-xyz`) | discourse | forums.derive.xyz | en | 20 | 20 | 1 | 2026-11-18 |
| Minaprotocol (forum, forums.minaprotocol.com) (`discourse-forums-minaprotocol-com`) | discourse | forums.minaprotocol.com | en | 20 | 20 | 0 | 2026-11-11 |
| Balanced (governance, gov.balanced.network) (`discourse-gov-balanced-network`) | discourse | gov.balanced.network | en | 14 | 14 | 0 | 2026-11-21 |
| Valuepickr (forum, forum.valuepickr.com) (`discourse-forum-valuepickr-com`) | discourse | forum.valuepickr.com | en | 20 | 20 | 0 | 2026-11-21 |
| FYERS Community (fyers.in/community) (`discourse-fyers-in`) | discourse | fyers.in | en | 20 | 20 | 0 | 2026-11-21 |
| Archway (governance, gov.archway.io) (`discourse-gov-archway-io`) | discourse | gov.archway.io | en | 20 | 20 | 0 | 2026-11-20 |
| DeCenter – Blockchain and Bitcoin (Telegram @DeCenterOrg) (`telegram-decenterorg`) | telegram | t.me/decenterorg | en | 20 | 20 | 0 | 2026-11-21 |
| Centrifuge (governance, gov.centrifuge.io) (`discourse-gov-centrifuge-io`) | discourse | gov.centrifuge.io | en | 20 | 20 | 0 | 2026-11-16 |
| Bancor (governance, gov.bancor.network) (`discourse-gov-bancor-network`) | discourse | gov.bancor.network | en | 20 | 20 | 1 | 2026-11-03 |
| Bitcointalk — Italiano (Italian) (`btt-28`) | smf-board | bitcointalk.org | it | 20 | 20 | 0 | 2013-10-24 |
| 1inch (governance, gov.1inch.network) (`discourse-gov-1inch-network`) | discourse | gov.1inch.network | en | 20 | 20 | 2 | 2026-11-20 |
| Frax (governance, gov.frax.finance) (`discourse-gov-frax-finance`) | discourse | gov.frax.finance | en | 20 | 20 | 3 | 2026-11-04 |
| Blackpool (governance, gov.blackpool.finance) (`discourse-gov-blackpool-finance`) | discourse | gov.blackpool.finance | en | 20 | 20 | 3 | 2026-05-13 |
| Fluid (governance, gov.fluid.io) (`discourse-gov-fluid-io`) | discourse | gov.fluid.io | en | 20 | 20 | 0 | 2026-08-02 |
| Gmx (governance, gov.gmx.io) (`discourse-gov-gmx-io`) | discourse | gov.gmx.io | en | 20 | 20 | 1 | 2026-11-16 |
| Gitcoin (governance, gov.gitcoin.co) (`discourse-gov-gitcoin-co`) | discourse | gov.gitcoin.co | en | 20 | 20 | 0 | 2026-11-21 |
| Ethenafoundation (governance, gov.ethenafoundation.com) (`discourse-gov-ethenafoundation-com`) | discourse | gov.ethenafoundation.com | en | 20 | 20 | 0 | 2026-11-17 |
| Goldfinch (governance, gov.goldfinch.finance) (`discourse-gov-goldfinch-finance`) | discourse | gov.goldfinch.finance | en | 20 | 20 | 1 | 2026-09-06 |
| Binance Killers® (Telegram @binancekillers) (`telegram-binancekillers`) | telegram | t.me/binancekillers | en | 20 | 20 | 0 | 2026-11-21 |
| Hashflow (governance, gov.hashflow.com) (`discourse-gov-hashflow-com`) | discourse | gov.hashflow.com | en | 20 | 20 | 0 | 2026-11-13 |
| Karate (governance, gov.karate.com) (`discourse-gov-karate-com`) | discourse | gov.karate.com | en | 1 | 1 | 0 | 2026-10-07 |
| Metalswap (governance, gov.metalswap.finance) (`discourse-gov-metalswap-finance`) | discourse | gov.metalswap.finance | en | 13 | 13 | 0 | 2026-02-13 |
| Optimism (governance, gov.optimism.io) (`discourse-gov-optimism-io`) | discourse | gov.optimism.io | en | 20 | 20 | 2 | 2026-11-21 |
| Near (governance, gov.near.org) (`discourse-gov-near-org`) | discourse | gov.near.org | en | 20 | 20 | 1 | 2026-11-21 |
| Liqwid (governance, gov.liqwid.finance) (`discourse-gov-liqwid-finance`) | discourse | gov.liqwid.finance | en | 20 | 20 | 0 | 2026-11-20 |
| Pareto / Idle (governance, gov.pareto.credit) (`discourse-gov-pareto-credit`) | discourse | gov.pareto.credit | en | 20 | 20 | 4 | 2026-01-27 |
| Ribbon (governance, gov.ribbon.finance) (`discourse-gov-ribbon-finance`) | discourse | gov.ribbon.finance | en | 20 | 20 | 1 | 2024-04-08 |
| Kamino (governance, gov.kamino.finance) (`discourse-gov-kamino-finance`) | discourse | gov.kamino.finance | en | 20 | 20 | 0 | 2026-10-06 |
| Wolf of Trading® (Telegram @wolfoftrading) (`telegram-wolfoftrading`) | telegram | t.me/wolfoftrading | en | 20 | 20 | 0 | 2026-11-19 |
| Renzoprotocol (governance, gov.renzoprotocol.com) (`discourse-gov-renzoprotocol-com`) | discourse | gov.renzoprotocol.com | en | 20 | 20 | 1 | 2026-03-02 |
| Velora / ParaSwap (governance, gov.velora.xyz) (`discourse-gov-velora-xyz`) | discourse | gov.velora.xyz | en | 20 | 20 | 0 | 2026-05-13 |
| Bitcointalk — Türkçe — Pazar Alanı (`btt-155`) | smf-board | bitcointalk.org | tr | 20 | 20 | 0 | 2026-11-19 |
| Silo (governance, gov.silo.finance) (`discourse-gov-silo-finance`) | discourse | gov.silo.finance | en | 20 | 20 | 3 | 2025-11-27 |
| Proofofhumanity (governance, gov.proofofhumanity.id) (`discourse-gov-proofofhumanity-id`) | discourse | gov.proofofhumanity.id | en | 20 | 20 | 0 | 2026-11-21 |
| Uniswap (governance, gov.uniswap.org) (`discourse-gov-uniswap-org`) | discourse | gov.uniswap.org | en | 20 | 20 | 3 | 2026-11-20 |
| Stakedao (governance, gov.stakedao.org) (`discourse-gov-stakedao-org`) | discourse | gov.stakedao.org | en | 20 | 20 | 6 | 2026-11-18 |
| Vitadao (governance, gov.vitadao.com) (`discourse-gov-vitadao-com`) | discourse | gov.vitadao.com | en | 20 | 20 | 0 | 2026-11-18 |
| Cartesi (governance, governance.cartesi.io) (`discourse-governance-cartesi-io`) | discourse | governance.cartesi.io | en | 20 | 20 | 1 | 2026-11-20 |
| Yearn (governance, gov.yearn.fi) (`discourse-gov-yearn-fi`) | discourse | gov.yearn.fi | en | 20 | 20 | 7 | 2026-11-17 |
| Vesper (governance, gov.vesper.finance) (`discourse-gov-vesper-finance`) | discourse | gov.vesper.finance | en | 20 | 20 | 0 | 2025-04-08 |
| Aave (governance, governance.aave.com) (`discourse-governance-aave-com`) | discourse | governance.aave.com | en | 20 | 20 | 1 | 2026-11-21 |
| Govern (forum, govern.iota.org) (`discourse-govern-iota-org`) | discourse | govern.iota.org | en | 20 | 20 | 1 | 2025-09-19 |
| Wing (governance, gov.wing.finance) (`discourse-gov-wing-finance`) | discourse | gov.wing.finance | en | 20 | 20 | 0 | 2026-10-19 |
| Ether (governance, governance.ether.fi) (`discourse-governance-ether-fi`) | discourse | governance.ether.fi | en | 20 | 20 | 0 | 2025-11-03 |
| Help (forum, help.nextcloud.com) (`discourse-help-nextcloud-com`) | discourse | help.nextcloud.com | en | 20 | 20 | 0 | 2026-11-21 |
| Puffer (governance, governance.puffer.fi) (`discourse-governance-puffer-fi`) | discourse | governance.puffer.fi | en | 20 | 20 | 1 | 2026-07-07 |
| Hiveon / HiveOS (forum górnicze, hiveon.com/forum) (`discourse-hiveon-com`) | discourse | hiveon.com | en | 12 | 12 | 0 | 2026-11-20 |
| Crypto Signals (Telegram @cryptosignals0rg) (`telegram-cryptosignals0rg`) | telegram | t.me/cryptosignals0rg | en | 18 | 18 | 0 | 2026-11-20 |
| Govforum (forum, govforum.kaia.io) (`discourse-govforum-kaia-io`) | discourse | govforum.kaia.io | en | 20 | 20 | 3 | 2026-11-11 |
| XMTP (forum, improve.xmtp.org) (`discourse-improve-xmtp-org`) | discourse | improve.xmtp.org | en | 20 | 20 | 0 | 2026-11-21 |
| imToken Fans (forum portfela) (`discourse-imtoken-fans`) | discourse | imtoken.fans | zh | 20 | 20 | 0 | 2024-11-22 |
| RadixTalk (radixtalk.com) (`discourse-radixtalk-com`) | discourse | radixtalk.com | en | 20 | 20 | 0 | 2026-11-20 |
| Magiceden (forum, magiceden.discourse.group) (`discourse-magiceden-discourse-group`) | discourse | magiceden.discourse.group | en | 20 | 20 | 0 | 2026-04-07 |
| MadeForTrade by Dhan (forum) (`discourse-madefortrade-in`) | discourse | madefortrade.in | en | 20 | 20 | 0 | 2026-11-21 |
| OneHack (forum) (`discourse-onehack-st`) | discourse | onehack.st | en | 20 | 20 | 0 | 2026-11-21 |
| Lido (research, research.lido.fi) (`discourse-research-lido-fi`) | discourse | research.lido.fi | en | 20 | 20 | 1 | 2026-11-21 |
| Star Atlas Club (forum gry) (`discourse-staratlas-club`) | discourse | staratlas.club | en | 1 | 1 | 0 | 2024-04-03 |
| Arbitrum (research, research.arbitrum.io) (`discourse-research-arbitrum-io`) | discourse | research.arbitrum.io | en | 20 | 20 | 2 | 2026-11-18 |
| Fat Pig Signals (Telegram @fatpigsignals) (`telegram-fatpigsignals`) | telegram | t.me/fatpigsignals | en | 18 | 18 | 0 | 2026-10-12 |
| Kas (research, research.kas.pa) (`discourse-research-kas-pa`) | discourse | research.kas.pa | en | 20 | 20 | 0 | 2026-10-22 |
| Syscoin (wsparcie, support.syscoin.org) (`discourse-support-syscoin-org`) | discourse | support.syscoin.org | en | 20 | 20 | 0 | 2026-08-10 |
| Smartcontract (forum, smartcontract.coiniran.com) (`discourse-smartcontract-coiniran-com`) | discourse | smartcontract.coiniran.com | fa | 20 | 20 | 0 | 2025-12-02 |
| Smartbch (research, research.smartbch.org) (`discourse-research-smartbch-org`) | discourse | research.smartbch.org | en | 6 | 6 | 2 | 2023-11-01 |
| Litecoin Talk (litecointalk.io) (`discourse-litecointalk-io`) | discourse | litecointalk.io | en | 20 | 20 | 0 | 2026-11-21 |
| Stargate (forum, stargate.discourse.group) (`discourse-stargate-discourse-group`) | discourse | stargate.discourse.group | en | 20 | 20 | 0 | 2025-08-24 |
| Jelurida (forum, talk.jelurida.com) (`discourse-talk-jelurida-com`) | discourse | talk.jelurida.com | en | 20 | 20 | 0 | 2026-08-28 |
| Harmony (forum, talk.harmony.one) (`discourse-talk-harmony-one`) | discourse | talk.harmony.one | en | 20 | 20 | 1 | 2026-11-13 |
| Tplinkforum (forum, tplinkforum.pl) (`discourse-tplinkforum-pl`) | discourse | tplinkforum.pl | pl | 20 | 20 | 0 | 2026-11-15 |
| Talk.Markets (forum) (`discourse-talk-markets`) | discourse | talk.markets | en | 20 | 20 | 0 | 2026-11-20 |
| Gridnet (forum, talk.gridnet.org) (`discourse-talk-gridnet-org`) | discourse | talk.gridnet.org | en | 20 | 20 | 0 | 2026-07-25 |
| Peercoin (forum, talk.peercoin.net) (`discourse-talk-peercoin-net`) | discourse | talk.peercoin.net | en | 20 | 20 | 0 | 2026-11-20 |
| zkResearch (zkresear.ch) (`discourse-zkresear-ch`) | discourse | zkresear.ch | en | 1 | 1 | 0 | 2024-09-11 |
| V2EX — węzeł bitcoin (`rss-v2ex-bitcoin`) | rss | v2ex.com | zh | 20 | 20 | 0 | 2026-10-30 |
| Vechain (forum, vechain.discourse.group) (`discourse-vechain-discourse-group`) | discourse | vechain.discourse.group | en | 20 | 20 | 8 | 2026-11-21 |
| Nervos (forum, talk.nervos.org) (`discourse-talk-nervos-org`) | discourse | talk.nervos.org | en | 20 | 20 | 0 | 2026-11-21 |
| 3DCenter Forum (`rss-3dcenter`) | rss | forum-3dcenter.org | de | 15 | 15 | 0 | 2026-11-21 |
| BitSharesTalk (forum BitShares, SMF) (`rss-bitsharestalk`) | rss | bitsharestalk.org | en | 5 | 0 | 0 | 2026-11-19 |
| OzBargain — tag cryptocurrency (okazje i dyskusje) (`rss-ozbargain-crypto`) | rss | ozbargain.com.au | en | 10 | 10 | 0 | 2026-11-12 |
| Trading Q&A by Zerodha (forum) (`discourse-tradingqna-com`) | discourse | tradingqna.com | en | 20 | 20 | 0 | 2026-11-21 |
| PTT — tablica DigiCurrency (`rss-ptt-digicurrency`) | rss | ptt.cc | zh | 20 | 20 | 0 | 2026-11-21 |
| CryptoFR — Crypto-monnaies (`rss-cryptofr-cryptomonnaies`) | rss | cryptofr.com | fr | 20 | 13 | 0 | 2026-07-06 |
| ComputerBase Forum — Kryptowährungen und Mining (`rss-computerbase-krypto`) | rss | computerbase.de | de | 20 | 20 | 0 | 2026-11-11 |
| Learn2Trade (Telegram @learn2trade) (`telegram-learn2trade`) | telegram | t.me/learn2trade | en | 20 | 20 | 0 | 2026-11-15 |
| BestBlackHatForum (MyBB) — najnowsze wątki (`rss-bestblackhatforum`) | rss | bestblackhatforum.com | en | 20 | 0 | 0 | 2026-11-21 |
| We (forum, we.opentech.fund) (`discourse-we-opentech-fund`) | discourse | we.opentech.fund | en | 20 | 20 | 0 | 2026-11-15 |
| Foro elhacker.NET — Criptomonedas (`rss-elhacker-criptomonedas`) | rss | foro.elhacker.net | es | 5 | 0 | 0 | 2026-11-02 |
| Flashback Forum — Kryptovalutor (`rss-flashback-kryptovalutor`) | rss | flashback.org | sv | 1 | 0 | 0 | — |
| Bogleheads (forum inwestorów) (`rss-bogleheads`) | rss | bogleheads.org | en | 10 | 10 | 0 | 2026-11-21 |
| Elite Trader — Crypto Assets (`rss-elitetrader-crypto`) | rss | elitetrader.com | en | 15 | 15 | 0 | 2026-11-21 |
| Hive (blockchain społecznościowy) — nowe wpisy z tagiem bitcoin (hiverss.com) (`rss-hive-bitcoin`) | rss | hiverss.com | en | 10 | 10 | 0 | 2026-11-21 |
| Financial Wisdom Forum (`rss-financialwisdomforum`) | rss | financialwisdomforum.org | en | 10 | 10 | 0 | 2026-11-21 |
| Hardwareluxx Community (`rss-hardwareluxx`) | rss | hardwareluxx.de | de | 20 | 20 | 0 | 2026-11-21 |
| Forex Station (forum traderów) (`rss-forexstation`) | rss | forex-station.com | en | 15 | 15 | 0 | 2026-11-21 |
| Lista bitcoindev (public-inbox gnusha.org) (`rss-gnusha-bitcoindev`) | rss | gnusha.org | en | 20 | 20 | 0 | 2026-11-20 |
| The Lemon Fool — Crypto and NFTs (`rss-lemonfool-crypto`) | rss | lemonfool.co.uk | en | 15 | 15 | 0 | 2026-11-21 |
| HardwareZone Forums — Money Mind (`rss-hardwarezone-moneymind`) | rss | forums.hardwarezone.com.sg | en | 20 | 20 | 0 | 2026-11-21 |
| Insomnia.gr — cała aktywność (`rss-insomnia`) | rss | insomnia.gr | el | 20 | 0 | 0 | 2026-11-21 |
| LowEndSpirit — Offers (`rss-lowendspirit-offers`) | rss | lowendspirit.com | en | 20 | 20 | 0 | 2026-11-02 |
| MoneySavingExpert Forum — Savings & investments (`rss-moneysavingexpert-investments`) | rss | forums.moneysavingexpert.com | en | 20 | 20 | 0 | 2026-11-20 |
| PIVX Forum (`rss-pivx-forum`) | rss | forum.pivx.org | en | 20 | 20 | 0 | 2026-11-19 |
| Wallstreet Queen Official® (Telegram @WallStreetQueenOfficial) (`telegram-wallstreetqueenofficial`) | telegram | t.me/wallstreetqueenofficial | en | 17 | 17 | 0 | 2026-11-21 |
| Technopat Sosyal (`rss-technopat`) | rss | technopat.net | tr | 19 | 19 | 0 | 2026-11-21 |
| Finance.ua forum (`rss-financeua`) | rss | forum.finance.ua | uk | 20 | 20 | 0 | 2026-11-21 |
| Overclock.net (`rss-overclocknet`) | rss | overclock.net | en | 20 | 20 | 0 | 2026-11-21 |
| ForoBeta — Bitcoin y Criptomonedas (`rss-forobeta-bitcoin`) | rss | forobeta.com | es | 20 | 20 | 0 | 2026-11-21 |
| Smart-Lab (społeczność traderów) (`rss-smartlab`) | rss | smart-lab.ru | ru | 20 | 20 | 0 | 2026-11-21 |
| Post4VPS (forum hostingowy, MyBB) (`rss-post4vps`) | rss | post4vps.com | en | 15 | 15 | 0 | 2026-01-06 |
| Trade2Win — Crypto (`rss-trade2win-crypto`) | rss | trade2win.com | en | 20 | 20 | 0 | 2026-10-09 |
| Wertpapier-Forum — Kryptowährungen (`rss-wertpapierforum-krypto`) | rss | wertpapier-forum.de | de | 20 | 0 | 0 | 2026-08-03 |
| WJunction — Crypto-currency (`rss-wjunction-crypto`) | rss | wjunction.com | en | 12 | 12 | 0 | 2026-11-18 |
| ServeTheHome Forums — Cryptocurrency Mining and Markets (`rss-servethehome-crypto`) | rss | forums.servethehome.com | en | 20 | 20 | 0 | 2026-05-18 |
| Acorn Domains (forum domenowe UK) (`rss-acorndomains`) | rss | acorndomains.co.uk | en | 20 | 20 | 0 | 2026-11-21 |
| Tildes — ~finance (`rss-tildes-finance`) | rss | tildes.net | en | 20 | 20 | 0 | 2026-11-17 |
| Benchmark.rs forum — Kriptovalute (`rss-benchmark-kriptovalute`) | rss | forum.benchmark.rs | sr | 20 | 20 | 0 | 2026-11-21 |
| Askaboutmoney — Alternative Investments (`rss-askaboutmoney-alternative`) | rss | askaboutmoney.com | en | 20 | 20 | 0 | 2026-11-21 |
| ADS.id (forum marketingu internetowego) (`rss-adsid`) | rss | ads.id | id | 20 | 20 | 0 | 2026-11-21 |
| Aussie Stock Forums (`rss-aussiestockforums`) | rss | aussiestockforums.com | en | 20 | 20 | 0 | 2026-11-21 |
| CoinSutra — komentarze (`rss-comments-coinsutra`) | rss | coinsutra.com | en | 9 | 9 | 0 | — |
| bit-tech.net Forums (`rss-bittech`) | rss | forums.bit-tech.net | en | 20 | 20 | 0 | 2026-11-21 |
| Bitcoin.fr — komentarze (`rss-comments-bitcoinfr`) | rss | bitcoin.fr | fr | 10 | 10 | 0 | 2026-10-29 |
| Kryptomagazin.cz — komentarze (`rss-comments-kryptomagazin-cz`) | rss | kryptomagazin.cz | cs | 20 | 20 | 0 | 2026-11-21 |
| Tạp chí Bitcoin — komentarze (`rss-comments-tapchibitcoin`) | rss | tapchibitcoin.io | vi | 1 | 1 | 0 | 2026-07-31 |
| Cryptoast — komentarze (`rss-comments-cryptoast`) | rss | cryptoast.fr | fr | 20 | 20 | 0 | 2026-11-21 |
| Ars OpenForum (`rss-arstechnica-forum`) | rss | arstechnica.com | en | 20 | 20 | 0 | 2026-11-21 |
| Fórum Adrenaline (`rss-adrenaline`) | rss | forum.adrenaline.com.br | pt | 20 | 20 | 0 | 2026-11-21 |
| Happy Coin News — komentarze (`rss-comments-happycoin`) | rss | happycoin.news | ru | 19 | 19 | 0 | 2026-11-12 |
| 1st Mining Rig — komentarze (`rss-comments-1stminingrig`) | rss | 1stminingrig.com | en | 10 | 10 | 0 | 2026-11-18 |
| Developpez.net forums (`rss-developpez`) | rss | developpez.net | fr | 15 | 15 | 0 | 2026-11-21 |
| CyberForum.ru (`rss-cyberforum`) | rss | cyberforum.ru | ru | 20 | 20 | 0 | 2026-11-21 |
| Canadian Money Forum (`rss-canadianmoneyforum`) | rss | canadianmoneyforum.com | en | 20 | 20 | 0 | 2026-11-21 |
| Bittiraha.fi — komentarze (`rss-comments-bittiraha`) | rss | bittiraha.fi | fi | 10 | 10 | 0 | 2026-01-10 |
| DNForum (handel domenami) (`rss-dnforum`) | rss | dnforum.com | en | 20 | 20 | 0 | 2026-11-21 |
| Crypto Inner Circle® (Telegram @CryptoInnerCircle) (`telegram-cryptoinnercircle`) | telegram | t.me/cryptoinnercircle | en | 19 | 19 | 0 | 2026-10-05 |
| DOU.ua — forum (`rss-dou-forums`) | rss | dou.ua | uk | 10 | 10 | 0 | 2026-11-21 |
| Guru3D Forums (`rss-guru3d`) | rss | forums.guru3d.com | en | 20 | 20 | 0 | 2026-11-21 |
| Digit Technology Discussion Forum (`rss-digit-community`) | rss | geek.digit.in | en | 10 | 10 | 0 | 2026-11-21 |
| hashcat Forum (m.in. odzyskiwanie haseł portfeli) (`rss-hashcat-forum`) | rss | hashcat.net | en | 15 | 15 | 0 | 2026-11-11 |
| EarnForex Forum — Cryptocurrencies (`rss-earnforex-crypto`) | rss | earnforex.com | en | 20 | 20 | 0 | 2026-10-26 |
| HostingDiscussion (`rss-hostingdiscussion`) | rss | hostingdiscussion.com | en | 20 | 20 | 0 | 2026-11-21 |
| io-tech TechBBS (`rss-iotech`) | rss | bbs.io-tech.fi | fi | 20 | 20 | 0 | 2026-11-21 |
| DiskusiWebHosting (forum hostingowe) (`rss-diskusiwebhosting`) | rss | diskusiwebhosting.com | id | 20 | 20 | 0 | 2026-11-21 |
| Forum Krstarice (`rss-krstarica`) | rss | forum.krstarica.com | sr | 20 | 20 | 0 | 2026-11-21 |
| Hatena Bookmark — wyszukiwanie „ビットコイン” (`rss-hatena-bitcoin`) | rss | b.hatena.ne.jp | ja | 20 | 0 | 0 | 2026-05-25 |
| LowEndBox — komentarze pod ofertami hostingu (`rss-comments-lowendbox`) | rss | lowendbox.com | en | 20 | 20 | 0 | 2026-11-21 |
| Malwarebytes Forums — cała aktywność (`rss-malwarebytes-forums`) | rss | forums.malwarebytes.com | en | 20 | 0 | 0 | 2026-11-21 |
| LinuxFr.org — tag bitcoin (`rss-linuxfr-bitcoin`) | rss | linuxfr.org | fr | 15 | 15 | 0 | 2026-05-11 |
| Uzmancoin — komentarze (`rss-comments-uzmancoin`) | rss | uzmancoin.com | tr | 10 | 10 | 0 | 2026-11-18 |
| NeoGAF (`rss-neogaf`) | rss | neogaf.com | en | 20 | 20 | 0 | 2026-11-21 |
| PC Games Hardware Extreme Forum (`rss-pcgh-extreme`) | rss | extreme.pcgameshardware.de | de | 20 | 20 | 0 | 2026-11-21 |
| PMBug — Cryptocurrency Bug (`rss-pmbug-crypto`) | rss | pmbug.com | en | 20 | 20 | 0 | 2026-11-21 |
| Neowin Forums — cała aktywność (`rss-neowin-forum`) | rss | neowin.net | en | 20 | 0 | 0 | 2026-11-21 |
| Qiita — tag bitcoin (`rss-qiita-bitcoin`) | rss | qiita.com | ja | 4 | 4 | 0 | 2026-11-20 |
| RaGEZONE (forum graczy/serwerów prywatnych) (`rss-ragezone`) | rss | forum.ragezone.com | en | 20 | 20 | 0 | 2026-11-21 |
| Root.cz fórum (`rss-root-cz-forum`) | rss | forum.root.cz | cs | 5 | 0 | 0 | 2026-11-21 |
| BitHub Krypto Polska (Telegram @bithub_pl) (`telegram-bithub-pl`) | telegram | t.me/bithub_pl | pl | 4 | 4 | 0 | 2025-01-15 |
| Ppomppu — tablica bitcoin (가상화폐) (`rss-ppomppu-bitcoin`) | rss | ppomppu.co.kr | ko | 14 | 14 | 0 | 2026-11-21 |
| CoinPost — komentarze (`rss-comments-coinpost`) | rss | coinpost.jp | ja | 16 | 16 | 0 | 2026-11-21 |
| Replace.org.ua (forum programistów) (`rss-replace-org-ua`) | rss | replace.org.ua | uk | 15 | 15 | 0 | 2026-11-20 |
| Pantip — nowe wątki (`rss-pantip`) | rss | pantip.com | th | 20 | 20 | 0 | 2026-11-21 |
| Stockaholics — Bitcoin Forum (`rss-stockaholics-bitcoin`) | rss | stockaholics.net | en | 20 | 20 | 0 | 2026-09-18 |
| PropertyChat (`rss-propertychat`) | rss | propertychat.com.au | en | 20 | 20 | 0 | 2026-11-21 |
| SweClockers — forum (`rss-sweclockers-forum`) | rss | sweclockers.com | sv | 20 | 0 | 0 | 2026-11-21 |
| ShareTrader (`rss-sharetrader`) | rss | sharetrader.co.nz | en | 20 | 20 | 0 | 2026-11-21 |
| Silver Stackers — Other Investments (`rss-silverstackers-other-investments`) | rss | silverstackers.com | en | 20 | 20 | 0 | 2026-09-27 |
| SecLists — Full Disclosure (`rss-seclists-fulldisclosure`) | rss | seclists.org | en | 15 | 0 | 0 | 2026-11-19 |
| Tom's Hardware Italia forum — Investimenti e Mercati Finanziari (`rss-tomshw-investimenti`) | rss | forum.tomshw.it | it | 20 | 20 | 0 | 2026-11-21 |
| TurkHackTeam (`rss-turkhackteam`) | rss | turkhackteam.org | tr | 20 | 20 | 0 | 2026-11-21 |
| ScamSurvivors Forum (zgłoszenia oszustw) (`rss-scamsurvivors`) | rss | scamsurvivors.com | en | 15 | 15 | 0 | 2026-11-21 |
| Zenn — temat bitcoin (`rss-zenn-bitcoin`) | rss | zenn.dev | ja | 20 | 20 | 0 | 2026-11-09 |
| ScamWarners Forum (zgłoszenia oszustw) (`rss-scamwarners`) | rss | scamwarners.com | en | 20 | 20 | 0 | 2026-11-21 |
| ngb.to (`rss-ngb`) | rss | ngb.to | de | 20 | 20 | 0 | 2026-11-21 |
| Bitcoin.pl (wpisy) (`rss-bitcoin-pl`) | rss | bitcoin.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| ZWAME Fórum (`rss-zwame`) | rss | forum.zwame.pt | pt | 20 | 20 | 0 | 2026-11-21 |
| Planet 3DNow! Forum (`rss-planet3dnow`) | rss | forum.planet3dnow.de | de | 20 | 20 | 0 | 2026-11-21 |
| Investing.com PL — wiadomości o kryptowalutach (`rss-investing-pl-kryptowaluty`) | rss | pl.investing.com | pl | 10 | 10 | 0 | 2026-11-21 |
| Cryptonews Polska (wpisy) (`rss-cryptonews-pl`) | rss | cryptonews.com | pl | 10 | 10 | 0 | 2026-10-20 |
| Tinhte.vn (`rss-tinhte`) | rss | tinhte.vn | vi | 20 | 20 | 0 | 2026-11-21 |
| TraderViet — Thị trường tiền điện tử (`rss-traderviet-crypto`) | rss | traderviet.io | vi | 20 | 20 | 0 | 2026-11-21 |
| Zaufana Trzecia Strona (wpisy) (`rss-zaufanatrzeciastrona`) | rss | zaufanatrzeciastrona.pl | pl | 10 | 10 | 0 | 2026-11-20 |
| MPCforum.pl — cała aktywność (`rss-mpcforum-cala-aktywnosc`) | rss | mpcforum.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Hejto.pl — gorące (`rss-hejto-gorace`) | rss | hejto.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Inwestomat.eu (komentarze) (`rss-inwestomat-komentarze`) | rss | inwestomat.eu | pl | 12 | 12 | 0 | 2026-11-21 |
| Społeczność Bitcoin.pl (Telegram @spolecznosc_bitcoin_pl) (`telegram-spolecznosc-bitcoin-pl`) | telegram | t.me/spolecznosc_bitcoin_pl | pl | 20 | 20 | 0 | 2026-11-16 |
| Kryptoprawo.pl (wpisy) (`rss-kryptoprawo`) | rss | kryptoprawo.pl | pl | 10 | 10 | 0 | 2026-08-17 |
| TradingView PL — pomysły społeczności (`rss-tradingview-pl`) | rss | pl.tradingview.com | pl | 20 | 0 | 0 | 2026-11-21 |
| VN-Zoom (`rss-vn-zoom`) | rss | vn-z.vn | vi | 20 | 20 | 0 | 2026-11-21 |
| Marcin Iwuć — Finanse Bardzo Osobiste (komentarze) (`rss-marciniwuc-komentarze`) | rss | marciniwuc.com | pl | 10 | 10 | 0 | 2026-11-19 |
| Independent Trader (komentarze) (`rss-independenttrader-komentarze`) | rss | independenttrader.pl | pl | 10 | 10 | 0 | 2026-11-21 |
| Subiektywnie o finansach (komentarze) (`rss-subiektywnieofinansach-komentarze`) | rss | subiektywnieofinansach.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Trading for a Living (komentarze) (`rss-tradingforaliving-komentarze`) | rss | tradingforaliving.pl | pl | 10 | 10 | 0 | 2026-10-15 |
| Pamiętnik Giełdowy (komentarze) (`rss-pamietnikgieldowy-komentarze`) | rss | pamietnikgieldowy.pl | pl | 20 | 20 | 0 | 2026-11-09 |
| Blogi bossa.pl (komentarze) (`rss-blogi-bossa-komentarze`) | rss | blogi.bossa.pl | pl | 10 | 10 | 0 | 2026-11-21 |
| LiveSmarter.pl (komentarze) (`rss-livesmarter-komentarze`) | rss | livesmarter.pl | pl | 8 | 8 | 0 | 2026-11-18 |
| Moniaki.pl (komentarze) (`rss-moniaki-komentarze`) | rss | moniaki.pl | pl | 10 | 10 | 0 | 2026-11-19 |
| Sekurak.pl (komentarze) (`rss-sekurak-komentarze`) | rss | sekurak.pl | pl | 10 | 10 | 0 | 2026-11-20 |
| Jak oszczędzać pieniądze (komentarze) (`rss-jakoszczedzacpieniadze-komentarze`) | rss | jakoszczedzacpieniadze.pl | pl | 20 | 20 | 0 | 2026-10-27 |
| SafeGroup.pl — najnowsze wątki (`rss-safegroup`) | rss | safegroup.pl | pl | 15 | 15 | 0 | 2026-11-21 |
| Stockbroker.pl (komentarze) (`rss-stockbroker-komentarze`) | rss | stockbroker.pl | pl | 10 | 10 | 0 | 2026-11-15 |
| forum.haker.edu.pl — posty (`rss-forum-haker-edu-pl`) | rss | forum.haker.edu.pl | pl | 15 | 15 | 0 | 2025-07-11 |
| Niebezpiecznik.pl (komentarze) (`rss-niebezpiecznik-komentarze`) | rss | niebezpiecznik.pl | pl | 15 | 15 | 0 | 2026-11-20 |
| ForumPC.pl — cała aktywność (`rss-forumpc-cala-aktywnosc`) | rss | forumpc.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| elektroda.pl — nowe tematy (`rss-elektroda`) | rss | elektroda.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Cashifam - oficjalny kanał Cashify (Telegram @cashifycrypto) (`telegram-cashifycrypto`) | telegram | t.me/cashifycrypto | pl | 12 | 12 | 0 | 2026-11-04 |
| Forum Pasja Informatyki — pytania i odpowiedzi (`rss-pasja-informatyki`) | rss | forum.pasja-informatyki.pl | pl | 20 | 0 | 0 | 2026-11-17 |
| Forbot.pl forum — cała aktywność (`rss-forbot-cala-aktywnosc`) | rss | forbot.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Informatyk Zakładowy (komentarze) (`rss-informatykzakladowy-komentarze`) | rss | informatykzakladowy.pl | pl | 10 | 10 | 0 | 2026-11-16 |
| Forum Linux Mint Polska (`rss-linuxmint-pl`) | rss | forum.linuxmint.pl | pl | 15 | 15 | 0 | 2026-11-20 |
| eko.one.pl — forum OpenWrt (`rss-eko-one-pl`) | rss | eko.one.pl | pl | 15 | 15 | 0 | 2026-11-20 |
| Forum SATKurier — cała aktywność (`rss-satkurier-cala-aktywnosc`) | rss | forum.satkurier.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| ForumSamochodowe.pl — nowości (`rss-forumsamochodowe`) | rss | forumsamochodowe.pl | pl | 15 | 0 | 0 | 2026-11-20 |
| Forum bukmacherskie.pl — ostatnie wpisy (`rss-forum-bukmacherskie`) | rss | forum.bukmacherskie.pl | pl | 10 | 10 | 0 | 2026-11-21 |
| Metin2 Polska — forum (wątki) (`rss-metin2-pl-forum`) | rss | board.pl.metin2.gameforge.com | pl | 20 | 20 | 0 | 2026-11-21 |
| Forum Plemiona (`rss-plemiona-forum`) | rss | forum.plemiona.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Grepolis PL — forum (`rss-grepolis-pl-forum`) | rss | pl.forum.grepolis.com | pl | 16 | 16 | 0 | 2026-11-21 |
| Forum Minecraft.pl — cała aktywność (`rss-minecraft-pl-cala-aktywnosc`) | rss | forum.minecraft.pl | pl | 20 | 0 | 0 | 2026-11-20 |
| Bazos.pl — najnowsze ogłoszenia (`rss-bazos-pl`) | rss | bazos.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Forge of Empires PL — forum (`rss-forgeofempires-pl-forum`) | rss | forum.pl.forgeofempires.com | pl | 20 | 20 | 0 | 2026-11-21 |
| Oglaszamy24.pl — najnowsze ogłoszenia (`rss-oglaszamy24`) | rss | oglaszamy24.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Comparic.pl (wpisy) (`rss-comparic-pl`) | rss | comparic.pl | pl | 20 | 20 | 0 | 2026-11-21 |
| Pepper.pl — nowe okazje (`rss-pepper-pl-nowe`) | rss | pepper.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| Ubuntu.pl — forum (`rss-ubuntu-pl-forum`) | rss | ubuntu.pl | pl | 20 | 20 | 0 | 2026-11-19 |
| WickedFire (forum afiliantów) (`rss-wickedfire`) | rss | wickedfire.com | en | 20 | 20 | 0 | 2026-11-21 |
| mastodon.internet-czas-dzialac.pl #kryptowaluty (`mastodon-tag-internet-czas-dzialac-kryptowaluty`) | mastodon-tag | mastodon.internet-czas-dzialac.pl | pl | 7 | 7 | 0 | 2026-07-25 |
| Cryptonews (Telegram @cryptonews_official) (`telegram-cryptonews-official`) | telegram | t.me/cryptonews_official | en | 20 | 20 | 0 | 2026-05-25 |
| #bitcoin @ norden.social (Mastodon) (`mastodon-tag-norden-social-bitcoin`) | mastodon-tag | norden.social | de | 18 | 18 | 0 | 2026-11-21 |
| MojaNorwegia.pl — wieści polonijne (`rss-mojanorwegia`) | rss | mojanorwegia.pl | pl | 20 | 0 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.uno (Mastodon) (`mastodon-tag-mastodon-uno-bitcoin`) | mastodon-tag | mastodon.uno | it | 13 | 13 | 0 | 2026-11-21 |
| Dojczland.info (komentarze) (`rss-dojczland-komentarze`) | rss | dojczland.info | pl | 10 | 10 | 0 | 2026-11-17 |
| #bitcoin @ mastodon.nl (Mastodon) (`mastodon-tag-mastodon-nl-bitcoin`) | mastodon-tag | mastodon.nl | nl | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodonapp.uk (Mastodon) (`mastodon-tag-mastodonapp-uk-bitcoin`) | mastodon-tag | mastodonapp.uk | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.scot (Mastodon) (`mastodon-tag-mastodon-scot-bitcoin`) | mastodon-tag | mastodon.scot | en | 18 | 18 | 0 | 2026-11-21 |
| Goniec (Toronto) — komentarze (`rss-goniec-komentarze`) | rss | goniec.net | pl | 10 | 10 | 0 | 2026-10-20 |
| #bitcoin @ nrw.social (Mastodon) (`mastodon-tag-nrw-social-bitcoin`) | mastodon-tag | nrw.social | de | 17 | 17 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.ie (Mastodon) (`mastodon-tag-mastodon-ie-bitcoin`) | mastodon-tag | mastodon.ie | en | 14 | 14 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.xyz (Mastodon) (`mastodon-tag-mastodon-xyz-bitcoin`) | mastodon-tag | mastodon.xyz | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.au (Mastodon) (`mastodon-tag-mastodon-au-bitcoin`) | mastodon-tag | mastodon.au | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.cloud (Mastodon) (`mastodon-tag-mastodon-cloud-bitcoin`) | mastodon-tag | mastodon.cloud | en | 8 | 8 | 0 | 2026-11-21 |
| #bitcoin @ universeodon.com (Mastodon) (`mastodon-tag-universeodon-com-bitcoin`) | mastodon-tag | universeodon.com | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.nz (Mastodon) (`mastodon-tag-mastodon-nz-bitcoin`) | mastodon-tag | mastodon.nz | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ toot.io (Mastodon) (`mastodon-tag-toot-io-bitcoin`) | mastodon-tag | toot.io | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ ohai.social (Mastodon) (`mastodon-tag-ohai-social-bitcoin`) | mastodon-tag | ohai.social | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ aus.social (Mastodon) (`mastodon-tag-aus-social-bitcoin`) | mastodon-tag | aus.social | en | 15 | 15 | 0 | 2026-11-21 |
| #bitcoin @ piaille.fr (Mastodon) (`mastodon-tag-piaille-fr-bitcoin`) | mastodon-tag | piaille.fr | fr | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mamot.fr (Mastodon) (`mastodon-tag-mamot-fr-bitcoin`) | mastodon-tag | mamot.fr | fr | 17 | 17 | 0 | 2026-11-21 |
| Coinpaper News (Telegram @coinpapernews) (`telegram-coinpapernews`) | telegram | t.me/coinpapernews | en | 20 | 20 | 0 | 2026-09-22 |
| #bitcoin @ sfba.social (Mastodon) (`mastodon-tag-sfba-social-bitcoin`) | mastodon-tag | sfba.social | en | 17 | 17 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.sdf.org (Mastodon) (`mastodon-tag-mastodon-sdf-org-bitcoin`) | mastodon-tag | mastodon.sdf.org | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mathstodon.xyz (Mastodon) (`mastodon-tag-mathstodon-xyz-bitcoin`) | mastodon-tag | mathstodon.xyz | en | 14 | 14 | 0 | 2026-11-21 |
| #bitcoin @ sciences.social (Mastodon) (`mastodon-tag-sciences-social-bitcoin`) | mastodon-tag | sciences.social | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.gamedev.place (Mastodon) (`mastodon-tag-mastodon-gamedev-place-bitcoin`) | mastodon-tag | mastodon.gamedev.place | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ fediscience.org (Mastodon) (`mastodon-tag-fediscience-org-bitcoin`) | mastodon-tag | fediscience.org | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ graz.social (Mastodon) (`mastodon-tag-graz-social-bitcoin`) | mastodon-tag | graz.social | de | 20 | 20 | 0 | 2026-11-20 |
| #bitcoin @ ruhr.social (Mastodon) (`mastodon-tag-ruhr-social-bitcoin`) | mastodon-tag | ruhr.social | de | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ wien.rocks (Mastodon) (`mastodon-tag-wien-rocks-bitcoin`) | mastodon-tag | wien.rocks | de | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ swiss.social (Mastodon) (`mastodon-tag-swiss-social-bitcoin`) | mastodon-tag | swiss.social | de | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ noc.social (Mastodon) (`mastodon-tag-noc-social-bitcoin`) | mastodon-tag | noc.social | en | 12 | 12 | 0 | 2026-11-21 |
| #bitcoin @ bonn.social (Mastodon) (`mastodon-tag-bonn-social-bitcoin`) | mastodon-tag | bonn.social | de | 6 | 6 | 0 | 2026-11-19 |
| #bitcoin @ masto.es (Mastodon) (`mastodon-tag-masto-es-bitcoin`) | mastodon-tag | masto.es | es | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ mastodonczech.cz (Mastodon) (`mastodon-tag-mastodonczech-cz-bitcoin`) | mastodon-tag | mastodonczech.cz | cs | 19 | 19 | 0 | 2026-11-19 |
| #bitcoin @ tooting.ch (Mastodon) (`mastodon-tag-tooting-ch-bitcoin`) | mastodon-tag | tooting.ch | de | 15 | 15 | 0 | 2026-11-21 |
| #bitcoin @ fedi.at (Mastodon) (`mastodon-tag-fedi-at-bitcoin`) | mastodon-tag | fedi.at | de | 20 | 20 | 0 | 2026-11-20 |
| #bitcoin @ witter.cz (Mastodon) (`mastodon-tag-witter-cz-bitcoin`) | mastodon-tag | witter.cz | cs | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.com.tr (Mastodon) (`mastodon-tag-mastodon-com-tr-bitcoin`) | mastodon-tag | mastodon.com.tr | tr | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ indieweb.social (Mastodon) (`mastodon-tag-indieweb-social-bitcoin`) | mastodon-tag | indieweb.social | en | 16 | 16 | 0 | 2026-11-21 |
| #bitcoin @ front-end.social (Mastodon) (`mastodon-tag-front-end-social-bitcoin`) | mastodon-tag | front-end.social | en | 20 | 20 | 1 | 2026-11-21 |
| MarketTwits (Telegram @markettwits) (`telegram-markettwits`) | telegram | t.me/markettwits | ru | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ toot.cafe (Mastodon) (`mastodon-tag-toot-cafe-bitcoin`) | mastodon-tag | toot.cafe | en | 20 | 20 | 0 | 2026-11-17 |
| #bitcoin @ ruby.social (Mastodon) (`mastodon-tag-ruby-social-bitcoin`) | mastodon-tag | ruby.social | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ phpc.social (Mastodon) (`mastodon-tag-phpc-social-bitcoin`) | mastodon-tag | phpc.social | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.com.br (Mastodon) (`mastodon-tag-mastodon-com-br-bitcoin`) | mastodon-tag | mastodon.com.br | pt | 14 | 14 | 1 | 2026-11-16 |
| #bitcoin @ mastodon.bida.im (Mastodon) (`mastodon-tag-mastodon-bida-im-bitcoin`) | mastodon-tag | mastodon.bida.im | it | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodonsweden.se (Mastodon) (`mastodon-tag-mastodonsweden-se-bitcoin`) | mastodon-tag | mastodonsweden.se | sv | 19 | 19 | 1 | 2026-11-17 |
| #bitcoin @ pawoo.net (Mastodon) (`mastodon-tag-pawoo-net-bitcoin`) | mastodon-tag | pawoo.net | ja | 9 | 9 | 0 | 2026-11-21 |
| #bitcoin @ sociale.network (Mastodon) (`mastodon-tag-sociale-network-bitcoin`) | mastodon-tag | sociale.network | it | 20 | 20 | 0 | 2026-11-20 |
| #bitcoin @ snabelen.no (Mastodon) (`mastodon-tag-snabelen-no-bitcoin`) | mastodon-tag | snabelen.no | no | 20 | 20 | 0 | 2026-11-19 |
| #bitcoin @ expressional.social (Mastodon) (`mastodon-tag-expressional-social-bitcoin`) | mastodon-tag | expressional.social | da | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.eus (Mastodon) (`mastodon-tag-mastodon-eus-bitcoin`) | mastodon-tag | mastodon.eus | eu | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ masto.pt (Mastodon) (`mastodon-tag-masto-pt-bitcoin`) | mastodon-tag | masto.pt | pt | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ linuxrocks.online (Mastodon) (`mastodon-tag-linuxrocks-online-bitcoin`) | mastodon-tag | linuxrocks.online | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ hessen.social (Mastodon) (`mastodon-tag-hessen-social-bitcoin`) | mastodon-tag | hessen.social | de | 18 | 18 | 0 | 2026-11-20 |
| #bitcoin @ social.cologne (Mastodon) (`mastodon-tag-social-cologne-bitcoin`) | mastodon-tag | social.cologne | de | 17 | 17 | 0 | 2026-11-21 |
| #bitcoin @ dresden.network (Mastodon) (`mastodon-tag-dresden-network-bitcoin`) | mastodon-tag | dresden.network | de | 20 | 20 | 0 | 2026-11-20 |
| #bitcoin @ mastodon.bayern (Mastodon) (`mastodon-tag-mastodon-bayern-bitcoin`) | mastodon-tag | mastodon.bayern | de | 20 | 20 | 0 | 2026-11-20 |
| #bitcoin @ social.coop (Mastodon) (`mastodon-tag-social-coop-bitcoin`) | mastodon-tag | social.coop | en | 16 | 16 | 0 | 2026-11-21 |
| #bitcoin @ nerdculture.de (Mastodon) (`mastodon-tag-nerdculture-de-bitcoin`) | mastodon-tag | nerdculture.de | de | 16 | 16 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.me.uk (Mastodon) (`mastodon-tag-mastodon-me-uk-bitcoin`) | mastodon-tag | mastodon.me.uk | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ econtwitter.net (Mastodon) (`mastodon-tag-econtwitter-net-bitcoin`) | mastodon-tag | econtwitter.net | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ federate.social (Mastodon) (`mastodon-tag-federate-social-bitcoin`) | mastodon-tag | federate.social | en | 19 | 19 | 0 | 2026-11-21 |
| CryptoQuant (Telegram @cryptoquant_official) (`telegram-cryptoquant-official`) | telegram | t.me/cryptoquant_official | en | 12 | 12 | 0 | 2026-11-20 |
| #bitcoin @ tilde.zone (Mastodon) (`mastodon-tag-tilde-zone-bitcoin`) | mastodon-tag | tilde.zone | en | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ tkz.one (Mastodon) (`mastodon-tag-tkz-one-bitcoin`) | mastodon-tag | tkz.one | es | 17 | 17 | 0 | 2026-11-19 |
| #bitcoin @ stranger.social (Mastodon) (`mastodon-tag-stranger-social-bitcoin`) | mastodon-tag | stranger.social | en | 19 | 19 | 0 | 2026-11-21 |
| #bitcoin @ newsie.social (Mastodon) (`mastodon-tag-newsie-social-bitcoin`) | mastodon-tag | newsie.social | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mstdn.business (Mastodon) (`mastodon-tag-mstdn-business-bitcoin`) | mastodon-tag | mstdn.business | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.top (Mastodon) (`mastodon-tag-mastodon-top-bitcoin`) | mastodon-tag | mastodon.top | en | 20 | 20 | 0 | 2026-11-21 |
| #bitcoin @ mastodon.de (Mastodon) (`mastodon-tag-mastodon-de-bitcoin`) | mastodon-tag | mastodon.de | de | 17 | 17 | 0 | 2026-11-21 |
| #bitcoin @ me.dm (Mastodon) (`mastodon-tag-me-dm-bitcoin`) | mastodon-tag | me.dm | en | 18 | 18 | 0 | 2026-11-21 |
| Bitcoin – !bitcoin@sh.itjust.works (Lemmy) (`lemmy-sh-itjust-works-bitcoin`) | lemmy | sh.itjust.works/c/bitcoin | en | 20 | 20 | 0 | 2026-11-13 |
| #bitcoin @ digitalcourage.social (Mastodon) (`mastodon-tag-digitalcourage-social-bitcoin`) | mastodon-tag | digitalcourage.social | de | 18 | 18 | 0 | 2026-11-21 |
| #bitcoin @ masto.nu (Mastodon) (`mastodon-tag-masto-nu-bitcoin`) | mastodon-tag | masto.nu | nl | 16 | 16 | 0 | 2026-11-21 |
| Bitcoin – !bitcoin@discuss.tchncs.de (Lemmy) (`lemmy-discuss-tchncs-de-bitcoin`) | lemmy | discuss.tchncs.de/c/bitcoin | en | 20 | 20 | 0 | 2026-11-01 |
| Blockchain, Web3 and Cryptocurrency Newsdesk – !news@blockchained.world (Lemmy) (`lemmy-blockchained-world-news`) | lemmy | blockchained.world/c/news | en | 20 | 20 | 0 | 2025-10-14 |
| Monero – !monero@lemmy.cafe (Lemmy) (`lemmy-lemmy-cafe-monero`) | lemmy | lemmy.cafe/c/monero | en | 20 | 20 | 0 | 2026-09-23 |
| Cryptocurrency Research and Discussion – !crypto@lemmygrad.ml (Lemmy) (`lemmy-lemmygrad-ml-crypto`) | lemmy | lemmygrad.ml/c/crypto | en | 10 | 10 | 0 | 2023-11-16 |
| Technology – !technology@lemmy.zip (Lemmy) (`lemmy-lemmy-zip-technology`) | lemmy | lemmy.zip/c/technology | en | 20 | 20 | 0 | 2026-11-21 |
| Privacy – !privacy@lemmy.dbzer0.com (Lemmy) (`lemmy-lemmy-dbzer0-com-privacy`) | lemmy | lemmy.dbzer0.com/c/privacy | en | 20 | 20 | 0 | 2026-11-21 |
| Cryptolancing – !cryptolancing@lemmy.wtf (Lemmy) (`lemmy-lemmy-wtf-cryptolancing`) | lemmy | lemmy.wtf/c/cryptolancing | en | 3 | 3 | 0 | 2024-08-16 |
| Finances – !finances@jlai.lu (Lemmy) (`lemmy-jlai-lu-finances`) | lemmy | jlai.lu/c/finances | fr | 20 | 20 | 0 | 2026-10-20 |
| Finance – !financ@midwest.social (Lemmy) (`lemmy-midwest-social-financ`) | lemmy | midwest.social/c/financ | en | 20 | 20 | 0 | 2026-11-21 |
| Privacy Pride – !privacypride@feddit.it (Lemmy) (`lemmy-feddit-it-privacypride`) | lemmy | feddit.it/c/privacypride | it | 20 | 20 | 0 | 2026-11-14 |
| Privacy – !privacy@europe.pub (Lemmy) (`lemmy-europe-pub-privacy`) | lemmy | europe.pub/c/privacy | en | 20 | 20 | 0 | 2026-10-30 |
| Sicurezza Informatica, Privacy e lotta al capitalismo della sorveglianza – !sicurezza@diggita.com (Lemmy) (`lemmy-diggita-com-sicurezza`) | lemmy | diggita.com/c/sicurezza | it | 20 | 20 | 0 | 2026-11-20 |
| Forum Debian Users Gang (`rss-debian-users-gang`) | rss | forum.dug.net.pl | pl | 15 | 15 | 0 | 2026-11-21 |
| Glassnode (Telegram @glassnode) (`telegram-glassnode`) | telegram | t.me/glassnode | en | 17 | 17 | 0 | 2026-11-21 |
| Finance – !Finance@lemmy.sdf.org (Lemmy) (`lemmy-lemmy-sdf-org-finance`) | lemmy | lemmy.sdf.org/c/finance | en | 20 | 20 | 0 | 2026-07-02 |
| Scams – !scams@hilariouschaos.com (Lemmy) (`lemmy-hilariouschaos-com-scams`) | lemmy | hilariouschaos.com/c/scams | en | 6 | 6 | 0 | 2026-03-02 |
| Monero – !monero@monero.town (Lemmy) (`lemmy-monero-town-monero`) | lemmy | monero.town/c/monero | en | 13 | 13 | 0 | 2026-11-15 |
| #bitcoin @ fedibird.com (Mastodon) (`mastodon-tag-fedibird-com-bitcoin`) | mastodon-tag | fedibird.com | ja | 10 | 10 | 0 | 2026-11-21 |
| CryptoRank Analytics (Telegram @CryptoRankNews) (`telegram-cryptoranknews`) | telegram | t.me/cryptoranknews | en | 19 | 19 | 0 | 2026-11-20 |
| CryptoDiffer News (Telegram @cryptodiffer) (`telegram-cryptodiffer`) | telegram | t.me/cryptodiffer | en | 20 | 20 | 0 | 2026-11-20 |
| WhaleBot Alerts 🐳 (Telegram @whalebotalerts) (`telegram-whalebotalerts`) | telegram | t.me/whalebotalerts | en | 20 | 20 | 0 | 2026-11-21 |
| Lookonchain (Telegram @lookonchainchannel) (`telegram-lookonchainchannel`) | telegram | t.me/lookonchainchannel | en | 12 | 12 | 9 | 2026-11-21 |
| SpotOnChain (Telegram @spotonchain) (`telegram-spotonchain`) | telegram | t.me/spotonchain | en | 20 | 20 | 0 | 2026-10-30 |
| Investigations by ZachXBT (Telegram @investigations) (`telegram-investigations`) | telegram | t.me/investigations | en | 20 | 20 | 9 | 2026-11-15 |
| BlockBeats (Telegram @theblockbeats) (`telegram-theblockbeats`) | telegram | t.me/theblockbeats | zh | 20 | 20 | 0 | 2026-11-21 |
| 方程式新闻 EquationNews (Telegram @BWEnews) (`telegram-bwenews`) | telegram | t.me/bwenews | zh | 20 | 20 | 0 | 2026-11-20 |
| TechFlow 深潮 ｜ 加密货币&区块链新闻 (Telegram @TechFlowDaily) (`telegram-techflowdaily`) | telegram | t.me/techflowdaily | zh | 20 | 20 | 0 | 2026-11-21 |
| CoinNess Global (Telegram @coinnessgl) (`telegram-coinnessgl`) | telegram | t.me/coinnessgl | en | 20 | 20 | 0 | 2026-11-21 |
| Tree News (Telegram @TreeNewsFeed) (`telegram-treenewsfeed`) | telegram | t.me/treenewsfeed | en | 20 | 20 | 0 | 2026-11-19 |
| CriptoNoticias (Telegram @criptonoticias) (`telegram-criptonoticias`) | telegram | t.me/criptonoticias | es | 20 | 20 | 0 | 2026-11-21 |
| Portal do Bitcoin (Telegram @portaldobitcoin) (`telegram-portaldobitcoin`) | telegram | t.me/portaldobitcoin | pt | 20 | 20 | 0 | 2026-11-21 |
| BTC-ECHO News (official) (Telegram @btcecho) (`telegram-btcecho`) | telegram | t.me/btcecho | de | 20 | 20 | 0 | 2026-11-21 |
| Coin68 (Telegram @coin68) (`telegram-coin68`) | telegram | t.me/coin68 | vi | 20 | 20 | 0 | 2026-11-21 |
| Catizen Announcement (Telegram @CatizenAnn) (`telegram-catizenann`) | telegram | t.me/catizenann | en | 19 | 19 | 0 | 2026-11-21 |
| tapswap community (Telegram @tapswapai) (`telegram-tapswapai`) | telegram | t.me/tapswapai | en | 20 | 20 | 0 | 2025-07-17 |
| Tomarket Announcement (Telegram @tomarket_ai) (`telegram-tomarket-ai`) | telegram | t.me/tomarket_ai | en | 18 | 18 | 0 | 2026-01-09 |
| @TRENDING (ETH / SOL) (Telegram @trending) (`telegram-trending`) | telegram | t.me/trending | en | 20 | 20 | 0 | 2026-11-21 |
| ICO SPEAKS NEWS (Telegram @icospeaksnews) (`telegram-icospeaksnews`) | telegram | t.me/icospeaksnews | en | 19 | 19 | 0 | 2026-11-21 |
| Airdrop Inspector (Telegram @airdropinspector) (`telegram-airdropinspector`) | telegram | t.me/airdropinspector | en | 17 | 17 | 0 | 2026-11-19 |
| Gram RUS (Telegram @toncoin_rus) (`telegram-toncoin-rus`) | telegram | t.me/toncoin_rus | ru | 19 | 19 | 0 | 2026-06-24 |
| TON Status (Telegram @tonstatus) (`telegram-tonstatus`) | telegram | t.me/tonstatus | en | 20 | 20 | 0 | 2026-11-17 |
| Binance Новости (Telegram @binance_ru) (`telegram-binance-ru`) | telegram | t.me/binance_ru | ru | 18 | 18 | 0 | 2026-11-19 |
| Coin Post – Деньги, инвестиции, биткоин (Telegram @Coin_Post) (`telegram-coin-post`) | telegram | t.me/coin_post | ru | 11 | 11 | 0 | 2026-11-21 |
| Bitcoin ™️ (Telegram @bitcoinnews) (`telegram-bitcoinnews`) | telegram | t.me/bitcoinnews | en | 20 | 20 | 0 | 2026-11-21 |
| Foresight News (Telegram @foresightnews) (`telegram-foresightnews`) | telegram | t.me/foresightnews | zh | 20 | 20 | 0 | 2026-11-21 |
| DeFi Million 💎 (Telegram @DeFiMillion) (`telegram-defimillion`) | telegram | t.me/defimillion | en | 20 | 20 | 0 | 2026-11-21 |
| Dexscreener Trending (Telegram @dexscreener_trending) (`telegram-dexscreener-trending`) | telegram | t.me/dexscreener_trending | en | 20 | 20 | 10 | 2026-11-10 |
