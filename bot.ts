import {
  json,
  serve,
  validateRequest,
} from "https://deno.land/x/sift@0.6.0/mod.ts";
import nacl from "https://esm.sh/tweetnacl@1.0.3?dts";
import { stringify } from "jsr:@std/dotenv/stringify";
import { EvalResult, roll, RollResult } from "npm:miniroll@^1.0.0";

serve({
  "/": home,
});

type Interaction = {
  type: number;
  data: {
    type: number;
    name: string;
    options: Option[];
  };
};

type Option = {
  name: string;
  type: number;
  value: string | number | boolean;
};

async function home(request: Request) {
  const { error } = await validateRequest(request, {
    POST: {
      headers: ["X-Signature-Ed25519", "X-Signature-Timestamp"],
    },
  });
  if (error) {
    return json({ error: error.message }, { status: error.status });
  }

  const { valid, body } = await verifySignature(request);
  if (!valid) {
    return json(
      { error: "Invalid request" },
      {
        status: 401,
      },
    );
  }

  const interaction: Interaction = JSON.parse(body);

  const { type, data } = interaction;

  // PING
  if (type === 1) {
    return json({
      type: 1,
    });
  }

  // APPLICTION COMMAND
  if (type === 2) {
    return handleCommand(data);
  }

  return json({ error: "bad request" }, { status: 400 });
}

function handleCommand({ name, options }: Interaction["data"]) {
  if (name === "roll") {
    const dice = options.find((o) => o.name === "dice");
    if (dice === undefined) {
      return json({
        type: 4,
        data: {
          content: "No dice notation given.",
        },
      });
    }

    let rollResult: RollResult;
    try {
      rollResult = roll(dice.value as string);
    } catch (_) {
      return json({
        type: 4,
        data: {
          content: "Failed to parse dice notation.",
        },
      });
    }

    const { result, normalized, calculation } = rollResult;

    const numbers = stringifyCalculation(calculation);

    return json({
      type: 4,
      data: {
        content: `${normalized} = ${numbers} = **${result}**`,
      },
    });
  }

  return json({ error: "bad request" }, { status: 400 });
}

function stringifyCalculation(calc: EvalResult): string {
  switch (calc.kind) {
    case "num":
      return `${calc.value}`;
    case "ident":
      return `${calc.value}`;
    case "roll":
      return `[${
        [...calc.rolls, ...calc.dropped.map((d) => `~~${d}~~`)].join(" + ")
      }]`;
    case "binary": {
      const lhs = stringifyCalculation(calc.intermediate.lhs);
      const rhs = stringifyCalculation(calc.intermediate.rhs);
      return lhs + " " + calc.intermediate.op + " " + rhs;
    }
  }
}

async function verifySignature(
  request: Request,
): Promise<{ valid: boolean; body: string }> {
  const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY")!;
  const signature = request.headers.get("X-Signature-Ed25519")!;
  const timestamp = request.headers.get("X-Signature-Timestamp")!;
  const body = await request.text();
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + body),
    hexToUint8Array(signature),
    hexToUint8Array(PUBLIC_KEY),
  );

  return { valid, body };
}

function hexToUint8Array(hex: string) {
  return new Uint8Array(
    hex.match(/.{1,2}/g)!.map((val) => parseInt(val, 16)),
  );
}
