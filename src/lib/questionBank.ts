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
  /** Vulgar mode variants — pick one randomly when contentMode is "vulgar". Question + insult format. */
  vulgarQuestions?: string[];
  /** Hint passed to /api/generate-joke to guide joke style */
  jokeContext: string;
  /** Silence-filler lines spoken if user doesn't respond (2 used, then skip) */
  prodLines: string[];
  /** IDs of questions that should be excluded from the session if this one is asked */
  excludes?: string[];
  /** Confidence threshold — confirm answer if confidence is below this (0-1). Higher = confirm more often. */
  confirmThreshold?: number;
  /** Echo-only templates (misheard repeat). {answer} = transcription; brain appends a tail filler after. */
  confirmTemplates?: string[];
}

/** Short skeptical pause beats after the confirm echo — gives the user a beat to correct, silence = roll with it. */
export const CONFIRM_TAIL_FILLERS = [
  "Hmm.",
  "Mmkay.",
  "Right?",
  "Got it.",
];

/** Default echo lines only — puppet repeats STT; tail filler queues next (see CONFIRM_TAIL_FILLERS). */
export const DEFAULT_CONFIRM_ECHO_TEMPLATES = [
  "{answer}?",
  "So — {answer}.",
  "{answer}.",
  "{answer}, huh?",
];

/** @deprecated Use DEFAULT_CONFIRM_ECHO_TEMPLATES — alias for older imports */
export const DEFAULT_CONFIRM_TEMPLATES = DEFAULT_CONFIRM_ECHO_TEMPLATES;

/** Lines spoken when confidence is too low to even attempt confirmation. */
export const REJECT_TEMPLATES = [
  "I didn't catch that. Say again?",
  "What was that?",
  "One more time.",
  "Sorry — say that again?",
];

/** STT often grabs the puppet's punchline — user repeats it into the mic. Re-ask; don't roast it as their answer. */
export const ECHO_REJECTION_TEMPLATES = [
  "That's my line — I need a real answer, not the joke echoing back.",
  "You can't just repeat what I said — give me an actual answer.",
  "The mic picked up my voice, not yours — try again.",
];

export const QUESTION_BANK: ComedyQuestion[] = [
  {
    id: "name",
    question: "Alright — what's your name?",
    vulgarQuestions: [
      "Alright, what's your name, you sad bastard?",
      "Let's start with the basics. Name? And don't bullshit me.",
      "What do they call you, besides a disappointment?",
      "What's your goddamn name?",
      "Who the hell are you? Name, please.",
    ],
    jokeContext: "Riff on name puns, famous people with that name, what the name implies about their personality.",
    prodLines: [
      "I asked your name, not for a moment of silence.",
      "It's two words — well, usually. What do I call you?",
    ],
    confirmThreshold: 0.8,
    confirmTemplates: [
      "{answer}?",
      "So — {answer}.",
      "{answer}.",
      "{answer}, huh?",
    ],
  },
  {
    id: "job",
    question: "And what do you do for a living?",
    vulgarQuestions: [
      "What the hell do you do for a living?",
      "What's the gig, smartass? How do you pay rent?",
      "What do you do all day, besides this?",
      "Tell me what you do for money. I need a laugh.",
      "What's your job, you beautiful disaster?",
    ],
    jokeContext: "Profession roast — job stereotypes, what the job reveals about their personality, unlikely career observations.",
    prodLines: [
      "You do something for money, right? Or is the vibe just... independently vibing?",
      "Job, career, hustle, grift — whatever you call it. What is it?",
    ],
    confirmThreshold: 0.5,
    confirmTemplates: [
      "{answer}?",
      "A {answer}?",
      "So — {answer}.",
      "{answer}.",
    ],
  },
  {
    id: "single",
    question: "Are you single?",
    vulgarQuestions: [
      "Are you single? Be honest, I already know.",
      "Anybody actually putting up with your shit, or are you single?",
      "Single? Married? Or just emotionally unavailable?",
      "You got a partner, or did they finally come to their senses?",
      "Tell me about your love life, you tragic bastard.",
    ],
    jokeContext: "Dating life, relationship status comedy — single = roast the solitude, taken = roast the partner's choices.",
    prodLines: [
      "I can already tell from the silence. That's an answer.",
      "Relationship status. I'm roasting you either way.",
    ],
  },
  {
    id: "age",
    question: "How old are you?",
    vulgarQuestions: [
      "How old are you, exactly? Don't lie, I can tell.",
      "What's the damage? How many years you got on you?",
      "How old? And don't shave a decade off, I'll know.",
      "Age, please. I want to know what kind of disaster I'm working with.",
      "How old are you, you weathered son of a bitch?",
    ],
    jokeContext: "Age roast — too young to know better, too old to be doing this, whatever the number implies about their life choices.",
    prodLines: [
      "The number. Just the number.",
      "It's okay. I'll be gentle. Probably.",
    ],
  },
  {
    id: "look",
    question: "What look were you going for today?",
    vulgarQuestions: [
      "What look were you going for today, and who let it happen?",
      "Explain the outfit. I want the crime scene report.",
      "What was the plan with this look, if there was one?",
      "Who styled you today, a power outage?",
      "Describe the aesthetic before I call it evidence.",
    ],
    jokeContext: "Style roast - what their outfit, hair, posture, and confidence suggest they attempted versus what landed.",
    prodLines: [
      "The look. Give it a name before I do.",
      "I can guess, but I'd rather hear the defense statement.",
    ],
  },
  {
    id: "bad_habit",
    question: "What's your worst habit that you pretend is a personality?",
    vulgarQuestions: [
      "What's your worst habit that you pretend is a personality, you menace?",
      "Name the red flag you keep rebranding as charm.",
      "What's the habit everyone around you is sick of?",
      "Tell me your worst habit. I want fresh ammunition.",
      "What toxic little routine are we calling self-care today?",
    ],
    jokeContext: "Bad habit roast - self-sabotage, annoying routines, red flags, and the gap between self-image and reality.",
    prodLines: [
      "Don't worry, your face already suggested a few. Pick one.",
      "Worst habit. Not all of them, we'll be here until winter.",
    ],
  },
  {
    id: "free_time",
    question: "What do you do when nobody is making you be useful?",
    vulgarQuestions: [
      "What do you do when nobody is making you be useful, if that ever happens?",
      "How do you waste time when nobody's supervising the disaster?",
      "What's your hobby, besides lowering expectations?",
      "When you're off the clock, what dumb little ritual eats your life?",
      "Tell me what you do for fun, and try not to make it sad.",
    ],
    jokeContext: "Hobby/free-time roast - how leisure choices reveal taste, avoidance, loneliness, delusion, or misplaced confidence.",
    prodLines: [
      "Hobby, habit, coping mechanism. Whatever you call it.",
      "What do you do for fun? And don't say 'this,' we're both suffering.",
    ],
  },
  {
    id: "delusion",
    question: "What are you weirdly confident about?",
    vulgarQuestions: [
      "What are you weirdly confident about, against all available evidence?",
      "What delusion are you most committed to?",
      "What do you think you're good at that your friends politely ignore?",
      "Where is your confidence most divorced from reality?",
      "What's your loudest, dumbest area of expertise?",
    ],
    jokeContext: "Confidence roast - overconfidence, delusion, fake expertise, and the mismatch between claim and visible reality.",
    prodLines: [
      "There has to be something. Confidence usually survives without evidence.",
      "What are you weirdly confident about? Besides sitting there like this.",
    ],
  },
];
