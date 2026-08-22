const bcrypt = require("bcryptjs");
const prisma = require("../src/config/prisma");

const SALT_ROUNDS = 10;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const email = String(args.email || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(args.password || process.env.ADMIN_PASSWORD || "");
  const name = String(args.name || process.env.ADMIN_NAME || "Admin").trim();

  if (!email) {
    throw new Error("Missing --email or ADMIN_EMAIL");
  }
  if (!password) {
    throw new Error("Missing --password or ADMIN_PASSWORD");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name,
      password: passwordHash,
      role: "ADMIN",
    },
    update: {
      name,
      password: passwordHash,
      role: "ADMIN",
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Admin account ready: ${user.email} (${user.role})`);
  // eslint-disable-next-line no-console
  console.log(`User ID: ${user.id}`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
