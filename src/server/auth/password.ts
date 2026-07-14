import argon2 from "argon2";

const options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32
} as const;

let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string) {
  return argon2.hash(password, options);
}

export async function verifyPassword(hash: string | null, password: string) {
  dummyHash ??= hashPassword("not-a-real-user-password");
  return argon2.verify(hash ?? await dummyHash, password);
}
