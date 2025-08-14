/// <reference lib="deno.unstable" />

import {
  json,
  serve,
  validateRequest,
} from "https://deno.land/x/sift@0.6.0/mod.ts";
import nacl from "https://esm.sh/tweetnacl@1.0.3?dts";
import { EvalResult, roll, RollResult } from "npm:miniroll@1.1.4";

import {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteractionData,
  APIInteraction,
  ButtonStyle,
  ComponentType,
  EmbedType,
  InteractionType,
  MessageFlags,
  RESTPatchAPIInteractionFollowupJSONBody,
} from "npm:discord-api-types/v10";

type CommandOptions = APIApplicationCommandInteractionDataOption<
  InteractionType.ApplicationCommand
>[];

type FollowUp = RESTPatchAPIInteractionFollowupJSONBody;

const CLIENT_ID = Deno.env.get("CLIENT_ID");
const BOT_TOKEN = Deno.env.get("BOT_TOKEN");

const kv = await Deno.openKv();

serve({
  "/": home,
});

function response(
  content: string,
  ephemeral: boolean = false,
  components: boolean = false,
) {
  let flags = 0;
  if (ephemeral) flags += MessageFlags.Ephemeral;
  if (components) flags += MessageFlags.IsComponentsV2;
  return json({
    type: 4,
    data: { content, flags },
  });
}

function reject(message: string, status: number = 400) {
  return json({ error: message }, { status });
}

async function home(request: Request) {
  const { error } = await validateRequest(request, {
    POST: {
      headers: ["X-Signature-Ed25519", "X-Signature-Timestamp"],
    },
  });
  if (error) {
    return reject(error.message, error.status);
  }

  const { valid, body } = await verifySignature(request);
  if (!valid) {
    return reject("Invalid request", 401);
  }

  const interaction: APIInteraction = JSON.parse(body);

  const { type, data, token } = interaction;
  const shortToken = token.slice(0, 8);

  // PING
  if (type === 1) {
    return json({ type: 1 });
  }

  // APPLICTION COMMAND
  if (type === 2) {
    const user = interaction.member?.user ?? interaction.user;
    if (user === undefined) {
      return reject("Command not issued by user.");
    }

    if (data.type !== 1) {
      return reject("Interaction is not from a slash command.");
    }

    console.log(
      `[${shortToken}] User "${user.username}" issued command \`${
        JSON.stringify(data)
      }\``,
    );

    const uid = user.id;

    handleCommand(data, uid, shortToken)
      .then((followUp) => {
        console.log(`[${shortToken}] Following up with: ${followUp}`);
        return fetch(
          `https://discord.com/api/v10/webhooks/${CLIENT_ID}/${token}/messages/@original`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bot ${BOT_TOKEN}`,
            },
            body: JSON.stringify(followUp),
          },
        );
      })
      .then(async (res) => {
        if (res.ok) console.log(`[${shortToken}] Followed up.`);
        else {
          console.error(
            `[${shortToken}] Error while following up:`,
            await res.text(),
          );
        }
      })
      .catch((err) => console.error(`[${shortToken}]`, err));

    const whisperOpt = data.options?.find((o) => o.name === "whisper");
    if (whisperOpt !== undefined && whisperOpt.type !== 5) {
      return reject("Invalid options");
    }
    const whisper = whisperOpt?.value === true;
    const ephemeral = whisper || data.name === "sync";
    const components = data.name === "spell";

    console.log(`[${shortToken}] Working on it...`);
    return response("-# _Working on it..._", ephemeral, components);
  }

  return reject("Bad request");
}

async function handleCommand(
  { name, options }: APIChatInputApplicationCommandInteractionData,
  uid: string,
  shortToken: string,
): Promise<FollowUp | null> {
  switch (name) {
    case "roll":
    case "r":
      return await handleRollCommand(options, uid);
    case "sync":
      return await handleSyncCommand(options, uid);
    case "spell":
      return await handleSpellCommand(options, uid, shortToken);
  }

  return null;
}

async function handleRollCommand(
  options: CommandOptions | undefined,
  uid: string,
): Promise<FollowUp | null> {
  const dice = options?.find((o) => o.name === "dice");
  if (dice === undefined) {
    return { content: "No dice notation given." };
  } else if (dice.type !== 3) {
    return null;
  }

  const sheet = await getSyncedSheetForUser(uid);
  const data = new Map<string, number>(Object.entries(sheet?.stats ?? {}));

  let rollResult: RollResult;
  try {
    rollResult = roll(dice.value as string, { data });
  } catch (err) {
    const content = err instanceof Error
      ? "\n```diff\n- " + err.message + "\n```"
      : "**_An unexpected error ocurred._**";
    return { content };
  }

  const { result, normalized, calculation } = rollResult;

  const numbers = stringifyCalculation(calculation);

  return { content: `### ${result}\n = \`${normalized}\` = ${numbers}` };
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
  stats: Record<string, number>;
}

async function handleSyncCommand(
  options: CommandOptions | undefined,
  uid: string,
): Promise<FollowUp | null> {
  const sidOpt = options?.find((o) => o.name === "id");
  if (sidOpt !== undefined && sidOpt.type !== 3) return null;

  const sid = sidOpt?.value;

  const sheet = sid === undefined
    ? await getSyncedSheetForUser(uid)
    : await syncSheetForUser(uid, sid);

  if (sheet === null) {
    return {
      content: sid !== undefined
        ? "**Failed to sync.**\nAre you sure the ID is correct and the sheet is public?"
        : "**Failed to sync.**\nMake sure your sheet still exists and is public.",
    };
  }
  return { content: `Synced character **${sheet.name}**.` };
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
    if (!res.ok) {
      console.error(await res.json());
      return null;
    }
    const sheet = await res.json();
    await kv.set(["syncedSheet", uid], sheet);
    return sheet;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function handleSpellCommand(
  options: CommandOptions | undefined,
  _uid: string,
  shortToken: string,
): Promise<FollowUp | null> {
  const searchTermOpt = options?.find((o) => o.name === "name");
  if (searchTermOpt === undefined || searchTermOpt.type !== 3) {
    return { content: "Invalid command arguments." };
  }

  let response;
  try {
    const res = await fetch(`https://fivee.co/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `#graphql
          query ($q: String!) {
            spells(filters:  {name_ilike: $q}) {
              id
            }
            spell(id: $q) {
              id
            }
          }
        `,
        variables: {
          q: searchTermOpt.value,
        },
      }),
    });

    if (!res.ok) {
      console.error(await res.text());
      return {
        components: [{
          "type": 10,
          "content": "Failed to fetch spell data.",
        }],
      };
    }

    response = await res.json();
  } catch (err) {
    console.error(err);
    return {
      components: [{
        "type": 10,
        "content": "Unexpected error fetching spell data.",
      }],
    };
  }

  const data = response.data;
  const spell = data.spell ??
    (data.spells.length === 0 ? data.spells[0] : null);

  if (spell !== null) {
    return {
      embeds: [
        {
          type: EmbedType.Image,
          image: {
            url: `https://fivee.co/snippets/spell-card/${spell.id}`,
          },
        },
      ],
    };
  }

  if (data.spells.length === 0) {
    return {
      components: [{
        "type": 10,
        "content": "Couldn't find a spell with that name or ID.",
      }],
    };
  }

  return {
    content: "Which spell?",
    components: [
      {
        "type": 10,
        "content": "**Which spell?**",
      },
      ...data.spells.map((spell: { id: string }) => ({
        type: ComponentType.Button,
        customId: `btn-${shortToken}-${spell.id}`,
        style: ButtonStyle.Primary,
      })),
    ],
  };
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
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((val) => parseInt(val, 16)));
}
