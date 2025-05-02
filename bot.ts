/// <reference lib="deno.unstable" />

import {
  json,
  serve,
  validateRequest,
} from "https://deno.land/x/sift@0.6.0/mod.ts";
import nacl from "https://esm.sh/tweetnacl@1.0.3?dts";
import { EvalResult, roll, RollResult } from "npm:miniroll@1.1.2";

const CLIENT_ID = Deno.env.get("CLIENT_ID");
const BOT_TOKEN = Deno.env.get("BOT_TOKEN");

const kv = await Deno.openKv();

serve({
  "/": home,
});

type Interaction = {
  type: number;
  token: string;
  data: {
    type: number;
    name: string;
    options: Option[];
  };
  member: {
    user: {
      id: string;
      username: string;
    };
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

  const { type, data, token } = interaction;
  const shortToken = token.slice(0, 8);

  // PING
  if (type === 1) {
    return json({
      type: 1,
    });
  }

  // APPLICTION COMMAND
  if (type === 2) {
    console.log(
      `[${shortToken}] User "${interaction.member.user.username}" issued command \`${
        JSON.stringify(data)
      }\``,
    );
    const uid = interaction.member.user.id;

    handleCommand(data, uid)
      .then(async (res) => {
        console.log(
          `[${shortToken}] Following up with: ${await res.clone().text()}`,
        );
        const resData = await res.json();
        const content = resData.data.content;
        return fetch(
          `https://discord.com/api/webhooks/${CLIENT_ID}/${token}/messages/@original`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bot ${BOT_TOKEN}`,
            },
            body: JSON.stringify({ content }),
          },
        );
      })
      .then(async (res) => {
        if (res.ok) console.log(`[${shortToken}] Followed up.`);
        else {console.error(
            `[${shortToken}] Error while following up:`,
            await res.text(),
          );}
      })
      .catch((err) => console.error(`[${shortToken}]`, err));

    console.log(`[${shortToken}] Working on it...`);
    return json({
      type: 4,
      data: {
        content: "-# _Working on it..._",
        flags: 64,
      },
    });
  }

  return json({ error: "bad request" }, { status: 400 });
}

async function handleCommand(
  { name, options }: Interaction["data"],
  uid: string,
): Promise<Response> {
  switch (name) {
    case "roll":
    case "r":
      return await handleRollCommand(options, uid);
    case "sync":
      return await handleSyncCommand(options, uid);
  }

  return json({ error: "bad request" }, { status: 400 });
}

async function handleRollCommand(
  options: Interaction["data"]["options"],
  uid: string,
) {
  const whisper = options.find((o) => o.name === "whisper")?.value === true;
  const flags = whisper ? 64 : 0;

  const dice = options.find((o) => o.name === "dice");
  if (dice === undefined) {
    return json({
      type: 4,
      data: {
        content: "No dice notation given.",
        flags,
      },
    });
  }

  const data = new Map<string, number>();
  const sheet = await getSyncedSheetForUser(uid);
  if (sheet !== null) {
    const pb = Math.ceil(sheet.level / 4) + 1;
    data.set("pb", pb);
    for (
      const [ability, { base, bonus, tempBonus, proficient }] of Object.entries(
        sheet.abilityScores,
      )
    ) {
      const score = base + bonus + tempBonus;
      const modifier = Math.floor((score - 10) / 2);
      data.set(`${ability}.base`, base);
      data.set(`${ability}.bonus`, bonus + tempBonus);
      data.set(`${ability}.score`, score);
      data.set(`${ability}.save`, modifier + (proficient ? pb : 0));
      data.set(ability, modifier);
    }
  }

  let rollResult: RollResult;
  try {
    rollResult = roll(dice.value as string, { data });
  } catch (err) {
    const detail = err instanceof Error
      ? ("\n```diff\n- " + err.message + "\n```")
      : "**_An unexpected error ocurred._**";
    return json({
      type: 4,
      data: {
        content: detail,
        flags,
      },
    });
  }

  const { result, normalized, calculation } = rollResult;

  const numbers = stringifyCalculation(calculation);

  return json({
    type: 4,
    data: {
      content: `### ${result}\n = \`${normalized}\` = ${numbers}`,
      flags,
    },
  });
}

function stringifyCalculation(calc: EvalResult): string {
  switch (calc.kind) {
    case "num":
      return `${calc.value}`;
    case "ident":
      return `${calc.value}`;
    case "roll":
      return calc.intermediateText;
    case "binary": {
      const lhs = stringifyCalculation(calc.intermediate.lhs);
      const rhs = stringifyCalculation(calc.intermediate.rhs);
      return lhs + " " + calc.intermediate.op + " " + rhs;
    }
  }
}

interface AbilityScore {
  base: number;
  bonus: number;
  tempBonus: number;
  proficient: boolean;
}

interface Sheet {
  id: string;
  owner: {
    id: string;
    name: string;
    picture: string;
  };
  publiclyVisible: boolean;
  name: string;
  species: string;
  class: string;
  level: number;
  abilityScores: {
    str: AbilityScore;
    dex: AbilityScore;
    con: AbilityScore;
    int: AbilityScore;
    wis: AbilityScore;
    cha: AbilityScore;
  };
}

async function handleSyncCommand(
  options: Interaction["data"]["options"],
  uid: string,
) {
  const newSheetId = options?.find((o) => o.name === "id")?.value as
    | string
    | undefined;

  const sheet = newSheetId === undefined
    ? await getSyncedSheetForUser(uid)
    : await syncSheetForUser(uid, newSheetId);

  if (sheet === null) {
    return json({
      type: 4,
      data: {
        content: newSheetId
          ? "**Failed to sync.**\nAre you sure the ID is correct and the sheet is public?"
          : "**Failed to sync.**\nMake sure your sheet still exists and is public.",
        flags: 64,
      },
    });
  }

  return json({
    type: 4,
    data: {
      content: `Synced character **${sheet.name}**.`,
      flags: 64,
    },
  });
}

async function getSyncedSheetForUser(uid: string): Promise<Sheet | null> {
  const doc = await kv.get<Sheet>(["syncedSheet", uid]);
  if (doc.value === null) return null;
  const sid = doc.value.id;
  return syncSheetForUser(uid, sid);
}

async function syncSheetForUser(
  uid: string,
  sid: string,
): Promise<Sheet | null> {
  try {
    const res = await fetch(`https://ashworth.fivee.co/api/characters/${sid}`);
    const sheet = await res.json();
    await kv.set(["syncedSheet", uid], sheet);
    return sheet;
  } catch (err) {
    console.error(err);
    return null;
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
