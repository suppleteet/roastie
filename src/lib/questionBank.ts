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
    question: "Okay, where are you from?",
    jokeContext: "Hometown stereotypes, regional jokes, what living there says about their choices.",
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
