# Privacy policy

Midnight Box is self-hosted: it runs on the computer of the person hosting the party (the host),
and everything it stores stays on that computer. The people who wrote Midnight Box never receive
any of it. There are no analytics, no ads, no tracking and no third-party scripts.

The host is responsible for the data on their computer. Questions about a party go to the host.

## If you're a guest

What Midnight Box keeps:

- **Your nickname** and a **random guest id**, saved on the host's computer. The id sits in a cookie
  that only this site can read; it expires 30 days after your last visit.
- **The songs you request.** Other guests and the TV screen see your nickname next to them.
  Requests are deleted once the house rules no longer need them (2 hours by default).
- **Your votes and skip votes**, in memory only. They're gone when the round or the song ends,
  or when the server restarts.
- **Your network address**, in memory only and never written to disk. It's used to count one vote
  per device, to work out how many guests are around for skip votes, to stop people the host
  removed from coming back, and to rate-limit requests. It's forgotten when the server restarts.

Your search terms go to Spotify (through the host's account) to find songs. They are not saved
or logged. Album covers load straight from Spotify's image servers, so Spotify sees your network
address when they do.

## If you're the host

- **Your Spotify login.** Midnight Box signs in with Spotify's PKCE flow, so it never sees your
  Spotify password. The login tokens are saved in the local database and used only to search for
  songs, see what's playing and control playback on your devices (permissions:
  `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`).
- **What played.** Every song that starts on your account while Midnight Box runs is noted so songs
  and artists can rest between plays. This history is deleted after the longest cooldown
  (2 hours by default).
- **Your host password** is stored only as an argon2id hash. Host sessions are stored only as a
  SHA-256 hash and expire after 12 hours.

## Who else receives data

- **Spotify**: search terms, the songs added to your queue and playback commands, all through the
  host's account. [Spotify's privacy policy](https://www.spotify.com/legal/privacy-policy/) applies.
- **Last.fm**, only if the host has set a Last.fm API key: the title and artist of the song that's
  playing, to find similar songs for vote rounds. No guest data is sent.
- Nobody else.

## Disconnecting and deleting

- **Disconnect Spotify** in the host panel deletes the saved Spotify login and the listening history
  straight away. To also remove Midnight Box's access on Spotify's side, open
  [spotify.com/account/apps](https://www.spotify.com/account/apps/) and remove the app.
- To delete everything else, stop Midnight Box and delete its `data` folder.
- Guests can clear this site's cookies to end their session, or ask the host to delete their data.

Changes to this policy are tracked in the project's repository on GitHub.
