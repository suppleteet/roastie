import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { PERSONA_IDS, DEFAULT_PERSONA, PERSONAS, type PersonaId } from "@/lib/personas";

interface GenerateQuestionRequest {
  persona: PersonaId;
  observations?: string[];
  setting?: string | null;
  knownFacts?: string[];
  conversationSoFar?: string[];
  imageBase64?: string;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
    }

    const body = (await req.json()) as GenerateQuestionRequest;
    const personaId: PersonaId = PERSONA_IDS.includes(body.persona) ? body.persona : DEFAULT_PERSONA;
    const persona = PERSONAS[personaId];

    const systemPrompt = `You are "${persona.name}".
Character voice: ${persona.toneDescription}

Your job: generate ONE short, natural question to ask the person on camera.

RULES:
- The question must feel like a natural next thing to say in a conversation — NOT like a game show or dating questionnaire.
- React to what you SEE if you can. If they're in an office: "So what do you do in that office?" If they're in a car: "Where are you headed?" If you can't tell where they are: "Where are you right now?"
- If you already know things about them (KNOWN FACTS), ask something that builds on what you've learned — not something you already know.
- Keep it SHORT. One sentence max. Casual, conversational tone.
- Easy to answer — don't ask deep philosophical questions or anything that requires a long explanation.
- The question should set up roastable material — whatever they answer, you should be able to make fun of it.
- Stay in character.

BAD examples (too formal, too game-show):
- "What's something you're most proud of?"
- "If you could have one superpower, what would it be?"
- "What's something you do that you'd never admit to anyone?"

GOOD examples (natural, observational, easy):
- "What's going on back there, where are you?"
- "So what do you do in that office?"
- "Is that your place or are you at work?"
- "You got any pets?"
- "What are you up to tonight?"
- "Where are you headed?"
- "Who's that behind you?"
- "What are you drinking?"

Return ONLY a JSON object: { "question": "the question text", "jokeContext": "hint for roasting their answer" }`;

    const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    const contextLines: string[] = [];
    if (body.observations?.length)
      contextLines.push(`WHAT YOU SEE: ${body.observations.join("; ")}`);
    if (body.setting)
      contextLines.push(`LOCATION: ${body.setting}`);
    if (body.knownFacts?.length)
      contextLines.push(`WHAT YOU ALREADY KNOW (don't ask about these): ${body.knownFacts.join(", ")}`);
    if (body.conversationSoFar?.length)
      contextLines.push(`RECENT CONVERSATION:\n${body.conversationSoFar.slice(-4).join("\n")}`);

    userParts.push({ text: contextLines.length > 0 ? contextLines.join("\n\n") : "Generate a natural question." });

    if (body.imageBase64) {
      userParts.push({ inlineData: { mimeType: "image/jpeg", data: body.imageBase64 } });
    }

    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: ROAST_MODEL,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 120,
      },
      contents: [{ role: "user", parts: userParts }],
    });

    const rawText = result.text ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ question: "So what's going on with you?", jokeContext: "General roast." });
    }

    const parsed = JSON.parse(jsonMatch[0]) as { question?: string; jokeContext?: string };
    return NextResponse.json({
      question: parsed.question ?? "So what's going on with you?",
      jokeContext: parsed.jokeContext ?? "General roast.",
    });
  } catch (err) {
    console.error("[generate-question]", err);
    return NextResponse.json({ question: "So what's going on with you?", jokeContext: "General roast." });
  }
}
