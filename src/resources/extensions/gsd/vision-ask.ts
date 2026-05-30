/**
 * Natural-language openers for milestone discussion.
 *
 * Keep these short and conversational. They are often the user's first prompt
 * when GSD starts shaping a project or milestone, so they should feel like a
 * collaborator starting a working session rather than a form field.
 */
import { randomInt } from "node:crypto";

export const VISION_ASK_VARIANTS = [
  "What are we building?",
  "What do you want to make next?",
  "What should this become?",
  "What are you picturing?",
  "Where should we take this?",
  "What should this milestone unlock?",
  "Tell me what you want to build.",
  "What should GSD help you shape?",
] as const;

export type VisionAskVariant = typeof VISION_ASK_VARIANTS[number];

export function chooseVisionAskVariant(
  pickIndex: (exclusiveMax: number) => number = randomInt,
): VisionAskVariant {
  const index = pickIndex(VISION_ASK_VARIANTS.length);
  return VISION_ASK_VARIANTS[index] ?? VISION_ASK_VARIANTS[0];
}
