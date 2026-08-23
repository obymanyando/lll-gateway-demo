import { z } from "zod";

/**
 * Validate config once, at boot, and export a typed object.
 *
 * TS note: `z.infer<typeof schema>` derives the TypeScript type FROM the
 * runtime schema. One source of truth. You never hand-write an `Env` interface
 * that can drift from the validation.
 */
/**
 * TS note: a generic function. `<T extends z.ZodTypeAny>` means "whatever
 * schema you hand me, I give you back a schema of that same type". Without the
 * generic you would lose the inner type and end up with ZodAny, which would
 * quietly widen every field it touches to `any`.
 */
function emptyAsUndefined<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), inner);
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),

  GATEWAY_API_KEY: z.string().min(1, "Set GATEWAY_API_KEY in .env"),

  // At least one of these must be present. Checked in .refine() below.
  // `emptyAsUndefined` matters: a copied .env.example leaves the unused key as
  // an empty string, and an empty string is not the same as "not configured".
  ANTHROPIC_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  OPENAI_API_KEY: emptyAsUndefined(z.string().min(1).optional()),

  // Model names live in config, not in code, so a renamed model is a .env edit.
  ANTHROPIC_MODEL_CHEAP: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-sonnet-4-6"),
  OPENAI_MODEL_CHEAP: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_STRONG: z.string().default("gpt-4o"),
});

const parsed = schema
  .refine((v) => v.ANTHROPIC_API_KEY !== undefined || v.OPENAI_API_KEY !== undefined, {
    message: "Set at least one of ANTHROPIC_API_KEY or OPENAI_API_KEY",
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof schema>;
