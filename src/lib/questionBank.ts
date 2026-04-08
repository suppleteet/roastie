/**
 * Question bank for the Comedian Brain Q&A cycle.
 *
 * These are the CORE get-to-know-you questions — just the essentials.
 * After these are exhausted, the brain generates contextual questions
 * via the LLM based on what it sees and what it's learned so far.
 *
 * The brain reads this array and shuffles it at session start.
 * "name" is always asked first; everything else is shuffled.
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
  /** Confidence threshold — confirm answer if confidence is below this (0-1). Higher = confirm more often. */
  confirmThreshold?: number;
  /** Templates for confirming the answer. {answer} is replaced with the transcription. */
  confirmTemplates?: string[];
}

/** Default confirm templates used for questions without custom ones (including contextual questions). */
export const DEFAULT_CONFIRM_TEMPLATES = [
  "{answer}?",
  "I heard {answer}. That right?",
  "{answer} — did I get that?",
];

/** Lines spoken when confidence is too low to even attempt confirmation. */
export const REJECT_TEMPLATES = [
  "I didn't catch that. Say again?",
  "What was that?",
  "One more time.",
  "Sorry — say that again?",
];

export const QUESTION_BANK: ComedyQuestion[] = [
  {
    id: "name",
    question: "Alright — what's your name?",
    jokeContext: "Riff on name puns, famous people with that name, what the name implies about their personality.",
    prodLines: [
      "I asked your name, not for a moment of silence.",
      "It's two words — well, usually. What do I call you?",
    ],
    confirmThreshold: 0.8,
    confirmTemplates: [
      "{answer}?",
      "Wait — {answer}?",
      "{answer}, is that right?",
      "Did you say {answer}?",
    ],
  },
  {
    id: "job",
    question: "And what do you do for a living?",
    jokeContext: "Profession roast — job stereotypes, what the job reveals about their personality, unlikely career observations.",
    prodLines: [
      "You do something for money, right? Or is the vibe just... independently vibing?",
      "Job, career, hustle, grift — whatever you call it. What is it?",
    ],
    confirmThreshold: 0.5,
    confirmTemplates: [
      "A {answer}? Really?",
      "{answer}. That tracks.",
      "{answer}?",
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
];
