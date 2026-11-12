# NasouNu

A multiplayer party game: guess what your friends love (or hate) most.

## Run it
    cd ~/taste-test
    python3 server.py

Open http://localhost:8000. Friends on the same Wi-Fi use the "Friends on Wi-Fi" address the server prints.

## Play online with anyone
    python3 server.py --online

This opens a free public HTTPS link through localhost.run using your Mac's built-in `ssh`, with no account needed.
Share the printed `https://….lhr.life` link. The link only works while your computer runs the server, and it changes each time you restart.

## Host it permanently (always-on link)
Push this folder to GitHub, then on https://render.com choose New → Blueprint and select the repo. `render.yaml` sets everything up.
Railway or Heroku-style hosts work too through the `Procfile`. The server reads the `PORT` variable the host provides.
Use `PORT=9000 python3 server.py` to change the port. No installs needed (Python 3.8+).

## Modes
- **Classic** – 5-card hand. The Chooser taps the submitted cards from worst to best. The worst pick earns 1 point and each step up earns 1 more, so the best pick earns N points when N cards were played. After each turn, everyone passes their leftover hand to the player on their left and draws back up to 5 (the host can switch passing off in the lobby).
- **Deluxe** – Same rules as Classic (hand of 5, pass left, rank worst to best), but each round has one category (Places, Foods, Activities, Entertainment, Animals, Things) and every card in that round comes from it. A new round deals everyone a fresh hand from the next category. The host picks each round's category or leaves it random.
- **Ranking direction** – Favorites, Least favorite, Alternate, or Random each turn.
- **Length** – 1 or 2 rounds (everyone is Chooser once per round). Most points wins.
- **Leaderboard** – The final screen shows points per round, and a room leaderboard tracks wins and points across every game played in that room.

Edit `cards.py` to add your own cards.
