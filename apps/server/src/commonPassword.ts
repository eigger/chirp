/**
 * Built-in check for passwords that are long enough but guessable: the words
 * at the top of every breach list combined with digits/symbols (`password123!`,
 * `Football2026`, `P@ssw0rd!!`), keyboard walks and sequences (`qwertyuiop`,
 * `1q2w3e4r5t`, `0987654321`), repeated characters or chunks (`aaaaaaaaaa`,
 * `abcabcabcabc`), and the username or chirp-related words with decorations
 * (`admin12345`, `chirpchirp`). Rules instead of a word list keep the bundle
 * small while covering thousands of variants (every base word x any
 * digit/symbol prefix or suffix x common letter substitutions). Multi-word
 * passphrases ("correct horse battery") are not affected.
 */

/** Lower-case base words; matched after leet substitution with only digits/symbols around them. */
const WORDS = new Set(
  `password passwort passwd passw0rd pass pwd secret secrets qwerty qwertz azerty letmein welcome iloveyou
  iloveu loveyou lovely love monkey dragon dragons football baseball basketball soccer hockey golf tennis
  master shadow sunshine princess superman batman spiderman starwars pokemon freedom whatever trustno trustnoone
  michael jennifer jordan hunter ranger buster thomas robert daniel charlie andrew matthew joshua jessica ashley
  amanda nicole michelle william richard joseph david james john anthony christopher justin austin
  computer internet samsung google apple microsoft linux ubuntu debian windows server homelab homeserver
  homeassistant hassio proxmox raspberry raspberrypi synology unraid truenas changeme default administrator admin
  root toor login access test testing tester guest user username demo sample example temp temporary
  summer winter spring autumn january february march april june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday angel baby flower butterfly chocolate cookie banana
  orange purple ginger pepper tigger cheese killer hello helloworld abc abcdef abcdefg asdf asdfgh asdfghjkl
  zxcvbn zxcvbnm qwertyuiop qazwsx liverpool chelsea arsenal barcelona realmadrid manchester juventus yankees
  cowboys steelers lakers mustang ferrari porsche corvette harley mercedes toyota nissan honda phoenix matrix
  merlin wizard maverick diamond silver golden money dollar family forever friends friend chirp chirpchirp canary
  smart smartctl monitor korea seoul sarang saranghae daehanminguk sexy hottie babygirl iloveyou princesa
  qwerasdf mypassword mypass newpassword oldpassword passpass nopassword letmeinnow welcomehome opensesame
  dashboard security secure unknown nothing anything everything zaq zaqxsw qweasd qweasdzxc`.split(/\s+/),
);

/** Strings that walks/sequences are read from (also reversed). */
const WALKS = [
  "abcdefghijklmnopqrstuvwxyz",
  "01234567890123456789",
  "qwertyuiopasdfghjklzxcvbnm",
  "qwertzuiopasdfghjklyxcvbnm",
  "azertyuiopqsdfghjklmwxcvbn",
  "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
  "zaq1xsw2cde3vfr4bgt5nhy6mju7",
  "qazwsxedcrfvtgbyhnujmikolp",
  "1q2w3e4r5t6y7u8i9o0p",
  "q1w2e3r4t5y6u7i8o9p0",
  "a1b2c3d4e5f6g7h8i9j0",
  "1a2b3c4d5e6f7g8h9i0j",
  "qweasdzxcrtyfghvbnuiojklm",
  "!@#$%^&*()_+",
];

/** Frequent long passwords that the rules above do not already catch. */
const LITERAL = new Set([
  "qwe123qwe123",
  "123qwe123qwe",
  "1qazxsw23edc",
  "zaq12wsxcde3",
  "aa1234567890",
  "abc1234567890",
  "a1234567890",
  "q1234567890",
  "1234567890q",
  "1234567890a",
  "1234qwerasdf",
  "qwer1234asdf",
  "asdf1234qwer",
  "1q2w3e4r5t6y",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "1qaz!qaz2wsx",
  "1qaz@wsx3edc",
  "!qaz2wsx#edc",
  "p@ssw0rd!!",
  "passw0rd!!",
  "p4ssw0rd123",
  "homeassistant1",
  "iloveyou1234",
  "11223344556677",
  "1122334455",
  "1212121212",
  "1231231231",
  "1234512345",
  "1234554321",
  "1357924680",
  "0987654321",
  "9876543210",
  "1029384756",
  "147258369",
  "1472583690",
  "3692581470",
  "7894561230",
  "1234567890",
  "12345678910",
  "123456789a",
  "123456789q",
  "1234567890-=",
]);

const LEET: Record<string, string> = {
  "@": "a",
  "4": "a",
  "8": "b",
  "(": "c",
  "3": "e",
  "6": "g",
  "9": "g",
  "#": "h",
  "1": "i",
  "!": "i",
  "|": "l",
  "0": "o",
  $: "s",
  "5": "s",
  "7": "t",
  "+": "t",
  "2": "z",
};

/** Words that make a password guessable for this server whatever surrounds them. */
const CONTEXT = "chirp|canary|admin|root|password|passwd|proxmox|smart|qwerty|login|secret";
const CONTEXT_ALL = new RegExp(CONTEXT, "g");
const CONTEXT_ANY = new RegExp(CONTEXT);

function deleet(s: string): string {
  return [...s].map((c) => LEET[c] ?? c).join("");
}

function isWalk(s: string): boolean {
  if (s.length < 6) return false;
  return WALKS.some((w) => w.includes(s) || [...w].reverse().join("").includes(s));
}

/** Repeated chunk (`abcabcabc`, `qwe123qwe123`) or very few distinct characters. */
function isRepetitive(s: string): boolean {
  if (new Set(s).size <= 3) return true;
  return /^(.{1,6})\1+(.{0,2})$/.test(s) && s.length >= 8;
}

/** Only digits, punctuation and spaces. */
function isDecoration(s: string): boolean {
  return /^[^\p{L}]*$/u.test(s);
}

export function isCommonPassword(password: string, username?: string | null): boolean {
  const lower = password.normalize("NFKC").toLowerCase();
  if (LITERAL.has(lower)) return true;
  if (isRepetitive(lower) || isWalk(lower)) return true;

  // Peel digits/symbols off both ends ("password123!", "2026football").
  const peeled = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (isWalk(peeled) && peeled.length >= lower.length - 4) return true;

  // Same again after letter substitutions ("p@ssw0rd", "f00tb4ll").
  const sub = deleet(lower);
  const core = sub.replace(/^[^a-z]+|[^a-z]+$/g, "");
  // Digits at the ends are decoration ("p4ssw0rd2026"): peel first, then substitute.
  const peeledSub = deleet(peeled).replace(/^[^a-z]+|[^a-z]+$/g, "");
  for (const candidate of new Set([peeled, core, peeledSub])) {
    if (!candidate) continue;
    if (WORDS.has(candidate)) return true;
    if (isRepetitive(candidate) || isWalk(candidate)) return true;
    // Built from server/brand words and at most 3 other letters ("chirpadmin", "adminchirp1").
    if (CONTEXT_ANY.test(candidate) && candidate.replace(CONTEXT_ALL, "").replace(/[^a-z]/g, "").length <= 3) return true;
    // Two base words glued together ("iloveyoumonkey", "dragonmaster").
    for (let i = 3; i <= candidate.length - 3; i++) {
      if (WORDS.has(candidate.slice(0, i)) && WORDS.has(candidate.slice(i))) return true;
    }
  }

  // The username itself with decorations ("admin2026!!", "ops-ops-ops").
  const name = username?.normalize("NFKC").toLowerCase();
  if (name && name.length >= 3) {
    for (const form of [lower, sub]) {
      if (form.includes(name) && isDecoration(form.split(name).join(""))) return true;
      if (form.includes(name) && form.split(name).join("").length <= 3) return true;
    }
  }
  return false;
}
