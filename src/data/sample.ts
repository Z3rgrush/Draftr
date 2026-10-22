import type { Project } from "../core/types";
import { defaultBible, defaultSettings } from "../core/project";

// A short sample with deliberate continuity errors, so the app has something to find:
// eye colour (ch. 1 vs ch. 6), age vs birth year (ch. 2 vs ch. 9), a dead man who
// speaks (ch. 4 vs ch. 7), a sergeant in Lisbon and Ashgrove on the same day
// (ch. 5 vs ch. 6), "Marcus"/"Markus" (ch. 8), an unresolved letter, and a
// journalist who vanishes for most of the book.

const scenes: [string, number, string, string, string, string][] = [
  [
    "The letter",
    1,
    "1998-03-01",
    "Ashgrove",
    "Hale",
    `The rain had not stopped for three days when Detective Inspector Elizabeth Hale found the unsigned letter on her desk. It had come without a stamp, folded twice, the ink already bleeding at the edges.

Hale turned it over under the lamp. Six words: You know what happened at the harbour. She read it again, then held it up so the light passed through the paper.

"Another one?" Sergeant Marcus Ortiz leaned in the doorway, coat dripping on the lino. He looked at Hale's green eyes, then at the letter, and decided not to joke.

"Third this month," Hale said. "Get it to forensics. And find out who at the Gazette is talking to Nora Pike."

Nora Pike had been outside the station all morning, notebook in hand, asking the same question of everyone who came out: who was Thomas Reed afraid of?`,
  ],
  [
    "Harbour master",
    2,
    "1998-03-03",
    "Ashgrove",
    "Hale",
    `Thomas Reed kept the harbour office like a ship's cabin, everything stowed, everything labelled. He poured two cups of tea without asking whether anyone wanted them.

Hale was thirty-four years old and had known Reed since she was a girl, when he used to let her ring the fog bell. She did not like the way his hands shook now.

"Someone's writing to you," Reed said. "I know, because they're writing to me too." He slid an envelope across the desk. The same paper. The same six words.

Outside, Nora Pike was photographing the boats. Ortiz pulled his collar up and went down to move her along, and came back with her card and a headache.`,
  ],
  [
    "The missing key",
    3,
    "1998-03-04",
    "Ashgrove",
    "Hale",
    `The missing key turned up on nobody's list. Reed swore the storeroom at the end of the quay had been locked since the fire, and that only he and the old harbour master had ever held a key.

Ortiz checked the storeroom door. Scratches around the lock, old ones. "Whoever had the key," he said, "they've been coming and going for years."

Nora Pike caught Hale on the steps of the station. "Reed's scared," she said. "Ask him about the fire in eighty-six." Hale said nothing, which Nora Pike seemed to take as an answer.`,
  ],
  [
    "Low tide",
    4,
    "1998-03-04",
    "Ashgrove",
    "Hale",
    `They found Thomas Reed at low tide, face down between the pilings. The gulls had got to him first.

Reed was dead, and had been for hours, the doctor said. Hale stood on the slipway with her hands in her pockets and watched the water take back the shore inch by inch.

In his coat pocket, sealed in a plastic bag, was a second unsigned note. Hale knew the letter writer had meant it for her.`,
  ],
  [
    "Lisbon",
    5,
    "1998-03-05",
    "Lisbon",
    "Ortiz",
    `Ortiz flew to Lisbon on the first flight from Bristol, because the watermark on the letters led to a stationer near the Alfama.

He spent the afternoon showing a photograph of Reed to shopkeepers who shrugged. The stationer's widow remembered a tall woman with a northern accent, who paid in cash.

Ortiz called Hale from a payphone by the river. "She bought a hundred sheets," he said. "Someone is planning to write a lot more."`,
  ],
  [
    "Wake",
    6,
    "1998-03-05",
    "Ashgrove",
    "Hale",
    `The wake was held at the Anchor, because Reed had drunk there for forty years. Ortiz stood at the bar with Hale, nursing a pint he had no intention of finishing.

Hale caught her own reflection in the mirror behind the optics, her brown eyes rimmed with red. She had not slept.

Across the room, someone had pinned a photograph of the old harbour office, taken before the fire. Hale looked at it for a long time.`,
  ],
  [
    "Visitors",
    7,
    "1998-03-07",
    "Ashgrove",
    "Hale",
    `Hale went back to the harbour office alone. The tea cups were still on the desk, washed and upside down on a folded cloth.

"You took your time, Liz," Reed said from the doorway, shaking rain from his hat. "I've been waiting since Tuesday."

Hale did not answer. She was looking at the drawer where the storeroom ledger used to be.`,
  ],
  [
    "The ledger",
    8,
    "1998-03-08",
    "Ashgrove",
    "Ortiz",
    `Markus Ortiz finally found the key taped beneath the drawer of the ledger cabinet, wrapped in a page torn from a tide table.

Inside the storeroom were twelve years of harbour records, and a box of letters in the same hand as the ones on Hale's desk.

Hale turned the pages slowly. The last entry was dated the night of the fire, in Reed's handwriting: Told her everything. God help me.`,
  ],
  [
    "Records",
    9,
    "1998-03-09",
    "Ashgrove",
    "Hale",
    `The records office smelled of damp and toner. Hale pulled her own file first, the way you check a mirror before a meeting.

She was born in 1960 in a terrace above the fish market, the same year the harbour office was built.

Ortiz brought coffee and a printout. "The fire in eighty-six," he said. "Reed was the one who called it in."`,
  ],
  [
    "Nora",
    10,
    "1998-03-12",
    "Ashgrove",
    "Hale",
    `Nora Pike's article ran on the Friday, under a photograph of the harbour at dusk. It named no one, which was somehow worse.

Nora Pike met Hale at the end of the quay. "You found the storeroom," she said. "Then you know who he was protecting."

Hale looked out at the water, where the tide was coming in over the pilings, and said she didn't know anything yet.`,
  ],
];

export function sampleProject(): Project {
  return {
    id: "sample-ashgrove",
    title: "The Ashgrove Letters (sample)",
    scenes: scenes.map(([title, chapter, date, location, pov, text], i) => ({
      id: `s${i + 1}`,
      title,
      chapter,
      date,
      location,
      pov,
      text,
      status: "draft",
    })),
    bible: defaultBible(),
    decisions: {},
    settings: { ...defaultSettings(), mode: "editor" },
  };
}
