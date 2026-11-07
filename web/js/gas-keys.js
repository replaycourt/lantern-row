// PUBLIC GAS KEYS. Yes, on purpose. Read this before you worry.
//
// Lantern Row players never see a wallet. Their browser makes an Ed25519 key, and every game action is
// signed with that key and relayed through the contract's `act` method. Somebody has to pay the gas
// for the relaying transaction, and on testnet that is `lantern-row-gas.testnet`, through the
// function-call keys below.
//
// Each key may ONLY call `act` and `advance_night` on `lantern-row.testnet`, and each has a capped
// allowance (2 NEAR, about 6,000 transactions). It cannot move NEAR, cannot touch any other contract
// and cannot change any game state: `act` checks the player's own signature, so a key holder can only
// relay what a player already signed. The worst anyone can do with these keys is burn the allowance,
// which stops free play until the pool is refilled. This is testnet; nothing here has value.
//
// Refill or extend the pool with `scripts/setup-gas-pool.mjs` from the gas account's full-access key,
// which is NOT in the repository and never will be.

export const GAS_ACCOUNT = 'lantern-row-gas.testnet'
export const CONTRACT = 'lantern-row.testnet'

export const RPC_HOSTS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']

export const GAS_KEYS = [
  { public_key: 'ed25519:8BDq5iW9pxqGia2bQAvRZKvG4WHQrt2YSqzEjLiy1W62', private_key: 'ed25519:XhAZCfyUyFitrA4fn4wE1SUjYwiEHNUYGvC55wtg9XpzSBxZAc3LdugarBMJrcCgWHsPZhhiGnJzRnwrzKp7J4e' },
  { public_key: 'ed25519:7xtyAU4KL7Nn6kbKG85UWg2TnX56iWeQpcSkYGeAgyRN', private_key: 'ed25519:3JoiUtfZUz4JmbcSt2gDV4mZXBU3BT8tNkkuMaYCuPyc468WWeNvFNdU7BJQuG4cxtpbu6f7Lw9Mj6gcL34VHLag' },
  { public_key: 'ed25519:CpdKXZh5wowcp9aNRfkk5R8CR6NRkPvpRjvJ4zLwkAcR', private_key: 'ed25519:2o3K4f3FiT3vy5FnTVi2QTxnL8YWEUq5bFaa7KUk91LeQsfNt9RB9CJv1edW1pSrReMLhot7S4nYyXiGbAWL3hC5' },
  { public_key: 'ed25519:7LejtPFmGVPiWGwVJp4a5HvdejAfPiN1C23twrEqrVti', private_key: 'ed25519:4cQGLEGhGgpzfPykdLKmSxUQXPcEg4hHLy6fk6CfsU9HNewWxfum1HBR7C3sdDZj3uhnVQivfCg4QmH7KgKK3oSW' },
  { public_key: 'ed25519:GvnJSD2Nrmvc5mr3x83nhEFxnGKHpbzMzRFPYQn8ZHzN', private_key: 'ed25519:4WXi4yqUCbpjHwimUYpae4kmPRGZroBxpJzRGqBzG6ASPLrCsqS58TUUsHd97UPWBx6R5fGyTXKU4nUBKawAhvfp' },
  { public_key: 'ed25519:2PaR7934Qv3byjVa2cbGRw58WNm26KQA5evCJaP773qC', private_key: 'ed25519:33zHWHWwMCSG4AuGRX5C7bDHFves4wXkKuPCLSxPqcsUPshgMxCbQ316pa8GHbBbNVTMTC8fAiDoXeFLht28sPnS' },
  { public_key: 'ed25519:8JwHSjXyDXb1Wr8ZQCDMJVCgKBR3j3iVPxwPA9yeB9uP', private_key: 'ed25519:4q3V9BnpKi3SUuZ8zgokpgkMT5XCaJw976qiZLtPmsrtHrRFiAkEXmNJiTpajBPHbRgXHA69efRkFpiZ8cF4N61s' },
  { public_key: 'ed25519:CagUXcDGv3SVcs1VbawocbEUFUZkUTVCv3veAMvFdpvx', private_key: 'ed25519:4kdzp87CiBX2JF6MjJsSY6d8SovUu6XEZfvGbvLTEYF4Cf1af7f3WBKFgdWBoySSCa3NUSq17JwqDx54GH2nkWrY' },
  { public_key: 'ed25519:4y6US39GkphnpT66YH8MqptgEqNgn5oGyfqK3zJWCQsN', private_key: 'ed25519:4aZCh9Pq7v8A9AvwsutXyma6urfQ6uWYa9vTk8GZ876PTFuCp6EDtvCor4jAzAqEncHJbz21mM543HvYbwMXxWsn' },
  { public_key: 'ed25519:FsSNGg7YmWiep1S1BEcucouJqMZ3fEc83NbniuUaEqP8', private_key: 'ed25519:3diLqiSPRS1Z5qEwWhgjNVsmVcu16W5AdQUpvuvAgXD4Ze4GdGCUwYJGu8KVv1knvyCxoNUJinQvUXsGqnnRjBVC' },
  { public_key: 'ed25519:DjQiFEDNeA8Axw9P9QscHdb2p3uRsXRBmeDS77VaHYkb', private_key: 'ed25519:gWgy9zfaBEKWGRGZcqyKa6sWfsqG85nDAebsXLJMEwgvYEjVtrrQmDFsgZqbAPU5Dnzsxj38HQYPknbd1N4CuZu' },
  { public_key: 'ed25519:69MXs25XsvdrbgvxPo3y1UpMT4tFCWzTkDTShoHz2JJ3', private_key: 'ed25519:5zH42VGDMg82o1b53Gxj59LoSB2gy4rdfyL6zDaZDcLgUYhigcMCTjy7BzPLDc3PnpBAydjmEqWNxWTBFRqEt8tf' },
  { public_key: 'ed25519:FKNnAJRvMvdr4mrYPQNoq64HSo84RkmacuuMxk49xRRk', private_key: 'ed25519:57EStKqSajRF9C6D5venScEa8DJqx7wWNFWjt3tm6nmntvSNdct6TxcWkhkzcXKGDf5GcNjC7D3HvPuodSY6Hfia' },
  { public_key: 'ed25519:2YBnkrUVDEjA4xggjFmJVYChGvW4Neo1nYuqHuP5Y4GN', private_key: 'ed25519:5ZunkEmZXcKybGyFbGtnRkNyg5KaDwwZUJWNDJv61oCcLGvEFQRTtNrF7NGsw99pUgNuW6RgPpKdq2NTsRq8ZdKk' },
]
