# Flow Cards

A swipe-through reviewer for your [Anki](https://apps.ankiweb.net) cards that runs in any modern browser and installs like an app on iPhone, Android, Windows, macOS and Linux.

It reads your due cards from Anki desktop through the **AnkiConnect** add-on and works offline once the day's cards are downloaded. Every answer is written back to Anki's real scheduler, so your progress stays in Anki and syncs to AnkiWeb, AnkiMobile and AnkiDroid as usual.

**Use it here:** <https://milo-griffiths.github.io/AddictiveFlashcards/>. You don't need to install or build anything, or have an account. The page only ever talks to *your own* Anki.

| Gesture | Action |
|---|---|
| Tap, or swipe ↑ | Flip the card |
| Swipe ↑ | Good |
| Swipe → | Easy |
| Swipe ← | Again (the card comes back after its learning step) |
| Swipe ↓ | Hard |
| ↶ (top right) | Undo the last answer(s), up to ~12 s after each swipe |

On a computer you can use the keyboard: **Space** flips, **arrow keys** grade, **Z** or **Backspace** undoes, and **E** opens the explanation.

As you drag, the card shows the grade and the next interval Anki would give it. A streak of correct answers builds a combo (×N) with bigger particle bursts, and every 10 in a row sets off confetti.

---

## What you need

- **Anki desktop** on a Windows, macOS or Linux computer, with the **AnkiConnect** add-on. Anki must be open whenever you want to download cards or send answers. In between, you can review offline.
- A **browser** on the device you'll review on: Safari, Chrome, Edge or Firefox.
- To review on a **phone, tablet or another computer**, you also need [Tailscale](https://tailscale.com) (free), so that device can reach Anki securely. See step 2.

There's a **demo deck** in settings (⚙︎ → *Try demo deck*) if you just want to see how it feels first.

---

## Setup

### 1. Install AnkiConnect and allow the app

1. In Anki: **Tools → Add-ons → Get Add-ons…**, enter code **`2055492159`**, then restart Anki.
2. **Tools → Add-ons →** select *AnkiConnect* **→ Config**. Add the address you'll open the app from to `webCorsOriginList`. For the hosted version:

   ```json
   "webCorsOriginList": ["http://localhost", "https://milo-griffiths.github.io"]
   ```

   The entry is the site's *origin*: scheme, host and port, with no path. If you run your own copy (option B below) or your own fork, add that origin instead, e.g. `"http://localhost:8000"` or `"https://yourname.github.io"`. The port must match exactly.
3. Click **OK** and **restart Anki** so the change takes effect.

### 2. Connect the app to Anki

Pick whichever fits how you want to review.

#### A. On the same computer as Anki (simplest)

Open the hosted app in your browser, then open settings (⚙︎) and set **AnkiConnect URL** to `http://localhost:8765`. Choose **Save & sync**.

Most browsers allow an https page to talk to `localhost`. Some ask you to allow access to devices on your local network, which you should allow. If it still says it can't reach Anki, use option B, which always works.

#### B. Run your own copy on the computer (works everywhere, offline-friendly)

The app is plain HTML, CSS and JavaScript with no build step, so any static file server works.

1. Download this repository (green **Code** button → **Download ZIP**, then unzip), or run `git clone https://github.com/Milo-Griffiths/AddictiveFlashcards.git`.
2. In a terminal, go into the folder and start a server:

   ```bash
   python3 -m http.server 8000
   ```

   On Windows, use `py -m http.server 8000`, or `python -m http.server 8000` (get Python from [python.org](https://www.python.org) or the Microsoft Store). With Node.js installed, `npx serve -l 8000` also works.
3. Add `"http://localhost:8000"` to `webCorsOriginList` (step 1) and restart Anki.
4. Open <http://localhost:8000> and set the AnkiConnect URL to `http://localhost:8765`.

#### C. On a phone, tablet or another computer (via Tailscale)

The hosted app uses HTTPS, so phones won't let it call a plain `http://192.168…` address. [Tailscale](https://tailscale.com) gives the computer running Anki a private HTTPS address that only your own devices can reach, from anywhere, not just home Wi-Fi.

1. Install Tailscale on **the computer running Anki** and on **your phone** (App Store or Google Play), and sign in to the same account on both.
2. In the [Tailscale admin console → DNS](https://login.tailscale.com/admin/dns), make sure **MagicDNS** is on and **enable HTTPS certificates**.
3. On the Anki computer, open a terminal and run:

   | OS | Command |
   |---|---|
   | macOS | `tailscale serve --bg 8765`. If `tailscale` isn't found (App Store version), use `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8765` |
   | Windows | `tailscale serve --bg 8765` in PowerShell or Command Prompt |
   | Linux | `sudo tailscale serve --bg 8765` |

   It prints an address like `https://my-computer.tailXXXX.ts.net`. That address only works for devices on your Tailscale account.
4. On the phone, open the app, go to settings (⚙︎), paste that address as the **AnkiConnect URL**, and choose **Save & sync**.

To stop sharing later, run `tailscale serve --https=443 off` (or `tailscale serve reset`).

> **Security:** `tailscale serve` is private to your own devices. Never expose AnkiConnect to the public internet (for example with `tailscale funnel` or port forwarding) unless you also set an `apiKey` in the AnkiConnect config and enter the same key in the app's settings. Otherwise anyone could read and edit your collection.

### 3. Install it like an app (optional)

| Device | How |
|---|---|
| iPhone / iPad | Open the app in **Safari** → Share → **Add to Home Screen** |
| Android | Open it in **Chrome** → ⋮ menu → **Add to Home screen** / **Install app** |
| Windows, macOS, Linux | In **Chrome** or **Edge**, click the install icon in the address bar (or ⋮ → *Install Flow Cards*). Firefox and Safari on desktop just use it as a normal tab. |

Installed, it opens full-screen and keeps working offline.

---

## Settings

| Setting | What it does |
|---|---|
| AnkiConnect URL / API key | Where your Anki is (see step 2). The key is only needed if you set `apiKey` in AnkiConnect. |
| Deck | Review one deck, or all decks. |
| New cards / Review cap | Upper limits for the day. Anki's own daily limits from your deck options also apply. |
| Sync Anki to AnkiWeb after reviews | After sending answers, ask Anki desktop to sync with AnkiWeb so your other devices see them. |
| Sound / Haptics | Haptics need Android, or iOS 18+. On iPhone, sound follows the silent switch. |
| Show the explanation automatically | After Hard or Again (default), after Again only, or never. |
| Not if I already opened it on that card | On by default. If you opened the explanation yourself before grading, it won't pop up again. |

## A week offline

Open the app once while Anki is reachable, and it downloads the whole day's cards, including learning cards due later. After that you can review with the computer closed. Cards you get wrong, and new or learning cards, come back after their real Anki step delay (from your deck options, e.g. 1 min then 10 min). If nothing else is left, they can come up to 20 minutes early, like Anki's "learn ahead". Answers wait on the device and are sent the next time Anki can be reached. Anki schedules them as of that moment, so intervals can be off by about a day.

Each sync also downloads **the next 6 days**: the reviews Anki has due on each day, plus each day's share of new cards (your daily limit, with exam-date pacing). Each day's cards appear on that day (Anki's day starts at 4am), so you can study for a week without reaching the computer. The "All caught up" screen says how many cards are ready for tomorrow.

**Offline repeats.** If you answer a card offline and Anki said it would come back within the week (e.g. Good → 3 days), the app shows it again on that day, marked *offline repeat*. Only a card's first answer is sent to Anki. AnkiConnect stamps every answer with the moment it arrives, so sending two answers for one card at once would wreck its schedule. Repeat answers count in your streak and stats but stay on the device. The next successful sync replaces everything downloaded ahead with Anki's real schedule. After a week away, a few cards may come back slightly early, because Anki didn't see their repeat.

The dot next to the cards-left count (top left) shows the state: **green** synced, **blinking blue** syncing, **amber** answers waiting (shown as e.g. **↑3**; on a narrow screen this note is hidden, but the count always shows), **grey** offline. Tap it to force a sync.

## Topics and practice mode

- **Topics** come from note tags of the form `Topic::Name` (e.g. `Topic::Biology`). Tap the **All topics ▾** button at the top to review one topic at a time (it then shows that topic's name). Notes without a topic tag still appear under *All topics*.
- **Practice:** **All topics ▾** → **Practice** tab. While practising, the button reads **Practice ▾**. Choose **Random** or **Hardest**, pick topics (or none for all), and how many cards (20, 50, 100 or all). **Nothing from practice is sent to Anki**, and today's review stats aren't touched. Again brings a card back a few cards later, Hard a little later. Your review session is parked and comes back exactly as it was when you tap *End practice*. Practised cards are kept on the device, so you can practise them offline later.
  - **Random:** a shuffled set, whether or not the cards are due. You can include cards you haven't studied yet.
  - **Hardest:** the cards you've been missing, worst first. Each studied card is scored from its last 12 answers in Anki's review log. Recent answers count most (each older one counts ×0.75), Hard counts as 0.6 of an Again, answers while first learning a card count half, and a card needs several misses to rank high. Cards with no recent misses are left out, and each card shows why it was picked (e.g. "missed 5 of last 6"). The ranking is saved, so this also works offline using the cards already on the device. Since practice isn't sent to Anki, practising a card doesn't lower its score. Answering it well in a real review does.

## Stats and exam dates

Tap the **chart icon** at the top (or *See your stats* on the "All caught up" screen). Everything comes from Anki's own review log, so reviews you do in Anki desktop count too. The last result is kept on the device, so the page opens instantly and still works offline (it says how old it is).

- **Today:** cards reviewed and the share you got right, your day streak (it glows once you've reviewed today), and what's due today and tomorrow.
- **Activity:** a 26-week heatmap and the last 30 days as bars. Tap any day for its count, time and recall. Time studied today, this week and in total. AnkiConnect logs 0 seconds for answers sent from the app, so the app times its own answers (capped at 60 s, like Anki). Older app answers count as about 10 s each.
- **Topics:** for each `Topic::` tag, a bar of *known* (next review in 3+ weeks), *learning* and *new*, plus how many reviews you got right in the last 30 days.
- **Exam dates:** tap a topic to set its exam date. Until then, that topic's new cards are paced so you've seen every one **5 days before the exam**, leaving time to review (at most 80 a day). These cards come first each day and can go over your daily new-card limit. Today's cards update when you close the page.
- **Coming up:** reviews due over the next 7 or 30 days, with the busiest day.
- **Struggling cards:** the cards you've pressed Again on most (3+ times). Tap one to see it with its explanation.
- **How you grade:** how often you pressed Again, Hard, Good and Easy in the last 30 days, with a tip if the mix looks off.
- **Records and goals:** best combo, longest streak, best day and all-time reviews, plus goals for reviews, day streak and combo. A small fanfare plays the first time you reach a new goal.

## Explanations (optional)

Each card can have a short explanation that appears behind an **Explain** button after you flip it, and opens by itself after Hard or Again. Explanations live in **one JSON file in Anki's media folder**, so they sync through AnkiWeb with your collection, and you don't need to change any note type or field:

- File name: `_flowcards_explanations.json` (the leading underscore stops Anki's *Check Media* from deleting it).
- Contents: an object mapping **note IDs** (as strings) to an HTML snippet. Simple tags work best: `<p> <b> <i> <code> <pre> <ul> <ol> <li> <table> <tr> <th> <td>`. Inline `<svg>` diagrams work too: give lines `class="w"`, shapes `class="g"`, and highlights `class="a"`, and they'll follow the app's colours. Tap a diagram to zoom. Anything that could run code (scripts, `on…` attributes, `javascript:` links) is stripped before display.

```json
{
  "1700000000000": "<p>Each comparison <b>halves</b> the search range, so it takes about log₂ n steps.</p>"
}
```

You can find a note's ID in Anki's browser: select a card and open **Card Info** (Ctrl+Shift+I, or Cmd+Shift+I on a Mac). AnkiConnect's `findNotes` action also returns them. To store the file, put it in your profile's `collection.media` folder (Tools → *Check Media* → *View Files* opens it), or send it with AnkiConnect's `storeMediaFile` action. The app picks it up on its next full sync.

**Bad explanation?** At the bottom of the explanation sheet, this tags the note `FlowCards::BadExplanation` in Anki, so you can find ones to rewrite with the search `tag:FlowCards::BadExplanation`. Tap again to remove the flag.

**Report a card.** Once a card is flipped, a faint flag sits in its bottom-right corner. Tap it to report a *Wrong answer*, an *Unclear question*, a *Confusing image* (on cards with a diagram) or a *Bad explanation*. Each one tags the note in Anki (`FlowCards::Report::WrongAnswer`, `::UnclearQuestion`, `::ConfusingImage`, or `FlowCards::BadExplanation`), so `tag:FlowCards::Report::*` finds everything reported. A reported card's flag turns red. Tap an option again to undo. Reports made offline are sent with your answers.

**Code formatting:** multi-line `<code>` on cards becomes a left-aligned code block, and `` `backticks` `` in card text become inline code. Cards tagged `Topic::C` or `Topic::Haskell` also get syntax colouring.

## Making good cards

The app works best with cards built like this. A full card has four parts: a **question and answer**, **tags**, an **explanation**, and sometimes an **image**.

### 1. The question and answer (Basic note type: Front / Back)

- **One fact per card.** If the answer needs "and", consider two cards. Swiping is fast, so many small cards beat a few big ones.
- **Give the context in the question.** Start with the subject so the card makes sense on its own, in any order and among other topics: *"In Verilog, …"*, *"In Git, …"*, *"In Haskell, …"*, *"In the context of a function from A to B, …"*.
- **Ask for exactly one thing**, phrased so only one answer fits. *"What does the literal 8'd17 represent?"* is better than *"Tell me about Verilog literals"*.
- **Keep answers short**: a phrase, a sentence or one line of code. Put the reasoning in the explanation instead.
- **Syntax cards:** use *"provide an example of code in use to …"* and answer with just the line, e.g. `output wire [3:0] z;`.
- **Contrast cards** for things that get mixed up: *"What is the difference between X and Y?"* answered as *"X does …, whereas Y does …"*.
- **Lists:** only when the list *is* the fact (e.g. the three properties of an equivalence relation). Keep them to about five items, or accept "any five".
- Avoid yes/no questions, and questions whose wording gives the answer away.

### 2. Tags

- `Topic::Name` (e.g. `Topic::Architecture`, `Topic::Haskell`): drives the topic picker, practice mode, topic mixing of new cards, and code colouring for `Topic::C` and `Topic::Haskell`. Give every note exactly one.
- Optionally, a source tag such as `CS1::Architecture::01-2_Boolean_Algebra` (course, topic, lecture) so you can find all the cards from one lecture.

### 3. The explanation

Shown behind **Explain**, and automatically after Hard or Again, so write it for the moment you got the card wrong. See *Explanations* above for the file format. A good one:

- **Says why, not just what** (roughly 60–200 words), in plain language.
- **Shows a small example**: a `<pre>` code block, a worked step or a short table.
- **Names the trap**: the common confusion, the thing it's often mixed up with, or a rule of thumb.
- **Links to the neighbouring idea** in one line (e.g. "the counterpart operator is concatenation `{ }`").

### 4. Images: only when the picture explains something

An image earns its place when **seeing it makes the answer easier to understand or remember** than reading it. That means there's structure, movement or change to show, such as:

- **Structure:** circuits and gates, memory layout, stack frames, linked lists, module/instance, trees.
- **Things over time:** waveforms, clock edges, delays, `initial` vs `always`.
- **Relationships:** sets and arrows for functions and relations, Venn diagrams, Hasse diagrams, git commit graphs.
- **A worked transformation:** data going in and out, e.g. `tr`, `map`/`filter` unrolled, a fold, a list comprehension.

**Don't add one** when it would only redraw the text: a line of syntax (`output wire [3:0] z;`), a command or flag name, a type signature, a list of laws or names, a plain definition, or an answer that already spells out every step.

**How images are added here:**

- Each image is a **self-contained SVG** named `fc_<noteId>.svg`, stored in Anki's media folder (AnkiConnect `storeMediaFile`).
- It's appended to the end of the **Back** field as `<br><img src="fc_<noteId>.svg">`, and the note is tagged `FlowCards::Image` so they're easy to find or remove.
- **Style:** an always-dark rounded background `#1c1c24` with text `#f2f2f5` and dimmed text `#8b8b99`. Highlights are gold `#ffc94d`, with green `#57e39b` for good/true, red `#ff5c7a` for bad/false and blue `#5cc8ff` for a second highlight. Fonts are the system sans-serif and monospace for code.
- **Size:** about 520 px wide. The app caps card images at 38% of the screen height, so keep diagrams wide rather than tall, and keep text at 12 px or larger so it reads on a phone.
- One short caption line at the bottom saying what to notice.
- The app downloads card images with the cards (they work offline) on its next full sync.

### Asking an AI to make cards

To make new cards from lecture notes, give the AI the notes and the rules above, plus something like:

> Make Anki Basic cards from these notes, one fact per card. Start each question with its context ("In Verilog, …"). Keep answers to a phrase or one line of code. Tag each with `Topic::<Name>` and `<Course>::<Topic>::<Lecture>`. For each card, also write a 60–200 word HTML explanation (`<p>`, `<b>`, `<code>`, `<pre>`, `<ul>`) that explains why, gives a small example and names the common confusion. Suggest an image only where a diagram shows structure, change over time, relationships or a worked transformation. Never for syntax, command names, type signatures or lists.

Then import the cards with AnkiConnect (`addNotes`), add the explanations to `_flowcards_explanations.json` under each new note ID, and add images as described above.

## Troubleshooting

| Message or symptom | Fix |
|---|---|
| *Can't reach Anki right now* | Is Anki open? Is the URL right? On a phone, check Tailscale is connected on both devices, and that `tailscale serve` is still running (`tailscale serve status`). |
| Works on the computer but not the phone | `localhost` on a phone means the phone itself. Use the Tailscale `https://….ts.net` address. |
| *iOS blocks plain http from an https page* | Use an `https://` address (Tailscale, option C) or run your own copy (option B). |
| Browser console says *blocked by CORS policy* | The app's origin isn't in `webCorsOriginList`, or Anki wasn't restarted. The origin must match exactly, port included. |
| An old version keeps loading | Close the app fully and reopen it, twice if needed. It checks for updates on launch. |

## Privacy

There's no server, account or analytics. The page is static files. Your cards and answers travel only between your browser and your own AnkiConnect, and they're cached in the browser's local storage on your device.

## Files

`index.html`, `style.css`, `app.js` (all the logic), `sw.js` (offline cache), `manifest.webmanifest`, and `icons/`. There's no build step. To host your own copy on GitHub Pages: fork the repo, then **Settings → Pages → Deploy from a branch → `main` / root**, and add your Pages origin to `webCorsOriginList`.
