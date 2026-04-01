/**
 * Question bank for the Comedian Brain Q&A cycle.
 *
 * Hot-swappable: add/remove/reorder questions here with zero code changes.
 * The brain reads this array and shuffles it at session start.
 *
 * Question text guidelines:
 * - Short and punchy — ElevenLabs reads them with natural prosody when they have
 *   a clear transition opener (e.g., "Alright —" or "Now tell me —")
 * - Open-ended or yes/no only — NEVER A/B either-or format
 * - Each question should feel like a setup for roastable material
 */

export interface ComedyQuestion {
  id: string;
  question: string;
  /** Hint passed to /api/generate-joke to guide joke style */
  jokeContext: string;
  /** Silence-filler lines spoken if user doesn't respond (2 used, then skip) */
  prodLines: string[];
  /** IDs of questions that should be excluded from the session if this one is asked */
  excludes?: string[];
}

export const QUESTION_BANK: ComedyQuestion[] = [
  {
    id: "name",
    question: "Alright — what's your name?",
    jokeContext: "Riff on name puns, famous people with that name, what the name implies about their personality.",
    prodLines: [
      "I asked your name, not for a moment of silence.",
      "It's two words — well, usually. What do I call you?",
    ],
  },
  {
    id: "hometown",
    question: "Now where are you from originally?",
    jokeContext: "Hometown stereotypes, regional jokes, what growing up there says about their life trajectory.",
    prodLines: [
      "Where did you crawl out of? I'm genuinely asking.",
      "The city. The state. The general direction. Anything.",
    ],
    excludes: ["city"],
  },
  {
    id: "job",
    question: "And what do you do for a living?",
    jokeContext: "Profession roast — job stereotypes, what the job reveals about their personality, unlikely career observations.",
    prodLines: [
      "You do something for money, right? Or is the vibe just... independently vibing?",
      "Job, career, hustle, grift — whatever you call it. What is it?",
    ],
  },
  {
    id: "single",
    question: "Are you single?",
    jokeContext: "Dating life, relationship status comedy — single = roast the solitude, taken = roast the partner's choices.",
    prodLines: [
      "I can already tell from the silence. That's an answer.",
      "Relationship status. I'm roasting you either way.",
    ],
  },
  {
    id: "age",
    question: "How old are you?",
    jokeContext: "Age roast — too young to know better, too old to be doing this, whatever the number implies about their life choices.",
    prodLines: [
      "The number. Just the number.",
      "It's okay. I'll be gentle. Probably.",
    ],
  },
  {
    id: "proud_of",
    question: "What's the thing you're most proud of in your life?",
    jokeContext: "Whatever they're proud of, undercut it — the achievement is the setup, the roast deflates their ego. If humble, roast the low bar.",
    prodLines: [
      "Come on, there must be something. Even if it's participation-trophy level.",
      "Anything. Literally anything you've done right.",
    ],
  },
  {
    id: "hobby",
    question: "What do you do for fun?",
    jokeContext: "Hobby stereotypes, what their choice of leisure says about their personality. Boring hobby = boring person. Wild hobby = overcompensating.",
    prodLines: [
      "You must do something besides stare at a screen. Right?",
      "Fun. Enjoyment. Recreation. Any of those ring a bell?",
    ],
  },
  {
    id: "superpower",
    question: "If you could have one superpower, what would it be?",
    jokeContext: "Their choice reveals their deepest insecurity. Flight = wants to escape. Invisibility = already invisible. Mind reading = trust issues. Roast the psychology behind the choice.",
    prodLines: [
      "Anything. Literally anything. What would you pick?",
      "Everybody's got an answer for this one. Even you.",
    ],
  },
  {
    id: "last_meal",
    question: "What's your go-to comfort food?",
    jokeContext: "Food choices reveal everything. Fast food = lazy. Fancy = pretentious. Ethnic food = roast their attempt at being cultured. Roast the choice and what it says about them.",
    prodLines: [
      "You eat food, right? What's the thing you can't resist?",
      "Come on, I know you've got a guilty pleasure.",
    ],
  },
  {
    id: "fear",
    question: "What's something that genuinely scares you?",
    jokeContext: "Their fear is comedic gold. Spiders = weak. Commitment = roast their love life. Public speaking = ironic given they're on camera right now. Use the fear against them.",
    prodLines: [
      "Besides what you see in the mirror. What scares you?",
      "Everyone's afraid of something. Spit it out.",
    ],
  },
  {
    id: "talent",
    question: "Do you have any hidden talents?",
    jokeContext: "If yes, undercut it. If no, roast the absence. If it's a weird talent, go all in on the weirdness. 'Hidden' implies even they know it's not good enough to show.",
    prodLines: [
      "Anything. Even a mediocre one counts.",
      "Hidden talents. Secret skills. Anything you're weirdly good at?",
    ],
  },
  {
    id: "celebrity",
    question: "Who do people say you look like?",
    jokeContext: "Roast the comparison — they probably look nothing like whoever they name. If nobody's told them, roast that too. Deflated celebrity comparison comedy.",
    prodLines: [
      "Anybody? A celebrity? A cartoon character? Anything?",
      "Come on, someone must have said something at some point.",
    ],
  },
  {
    id: "morning",
    question: "Are you a morning person?",
    jokeContext: "Morning people are annoyingly cheerful. Night owls are lazy. Either way it's roastable. Connect it to what you see — do they look like they've been up all night?",
    prodLines: [
      "Yes or no. I can probably tell by looking at you.",
      "Based on your face I'm guessing no, but go ahead.",
    ],
  },
  {
    id: "guilty_pleasure",
    question: "What's something you do that you'd never admit to anyone?",
    jokeContext: "Whatever they admit is automatically embarrassing — they just told a puppet on camera. The admission itself is the joke setup. Roast both the thing AND the fact they admitted it.",
    prodLines: [
      "This is a safe space. Well, no it isn't. But tell me anyway.",
      "I promise I won't judge. That's a lie, but go.",
    ],
  },
  {
    id: "city",
    question: "What city are you in right now?",
    jokeContext: "City-specific stereotypes and local roasts. What choosing to live there says about them.",
    prodLines: [
      "The city. The town. The general region. Work with me here.",
      "Even a state would help. I'm not picky.",
    ],
    excludes: ["hometown"],
  },
];
