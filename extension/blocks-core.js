// Page-reader core: the parts that decide what may leave the tab, with NO DOM access, so node can test them.
// Classic script (content scripts cannot be ES modules). In the browser it publishes globalThis.IsharaBlocks;
// under node (helper/test/blocks.test.ts evaluates this file in a vm context) the same object is module.exports.
// Contract: docs/TUTOR-INTERFACE.md sections 1 and 5.
(function (root) {
  "use strict";

  const REDACTED = "[redacted]";
  const BLOCK_MAX = 400;

  // ---- redaction ------------------------------------------------------------------------------------------------
  // WHY a field-name rule AND a shape rule: the name catches a secret the user typed into a box called "Recovery
  // phrase"; the shape catches a secret that sits in a box or paragraph with an innocent name (a copy button's
  // text, a "your key" card). Either one alone leaks.
  const SECRET_FIELD = /seed|mnemonic|recovery phrase|private key|secret|token|cvv|cvc|pin\b|password|passphrase|api[-_ ]?key|card[-_ ]?(number|num|no)\b|cc[-_]?(number|num)|security code|one[-_ ]?time|\botp\b/i;
  const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code|new-password|current-password)/i;

  // True when a control must never be read at all. `f` = { type, autocomplete, text } where text is the
  // name / id / label / placeholder / aria-label joined by the caller.
  function isSecretField(f) {
    if (!f) return false;
    if (String(f.type || "").toLowerCase() === "password") return true;
    const ac = String(f.autocomplete || "").toLowerCase().split(/\s+/);
    if (ac.some((a) => SECRET_AUTOCOMPLETE.test(a))) return true;
    return SECRET_FIELD.test(String(f.text || ""));
  }

  const SHAPES = [
    /\b0x[0-9a-fA-F]{64}\b/g,                                   // private key / tx hash with 0x
    /\b[0-9a-fA-F]{64}\b/g,                                     // 32 raw bytes in hex
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,                       // JWT
    /\bsk-[A-Za-z0-9_-]{8,}/g, /\bsk_live_\w{6,}/g, /\bsk_test_\w{6,}/g,
    /\bghp_\w{16,}/g, /\bgithub_pat_\w{16,}/g,
    /\bAKIA[0-9A-Z]{12,}/g, /\bxox[bp]-[\w-]{8,}/g,
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, // a whole PEM block
    /\b(?:0x)?[0-9a-fA-F]{32}[\s:,-]{1,3}[0-9a-fA-F]{32}\b/g,  // a 32-byte key split in two halves (audit 4)
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,                              // Indian PAN
  ];
  // Long base64/hex runs. A 40-hex run (a bare address) and 0x + 40 hex are public and kept. '-' and '_' are left out of
  // the class on purpose: URL slugs and kebab-case names are long and harmless.
  const LONG_RUN = /[A-Za-z0-9+/=]{40,}/g;
  const PUBLIC_ADDR = /^(0x)?[0-9a-fA-F]{40}$/;

  // BIP39 English (the public standard list, 2048 words). A recovery phrase is 12 to 24 of these in a row. Checking
  // the words themselves catches a phrase anywhere: inside a sentence ("your phrase is ..."), after a label, with commas,
  // or spread over 12 separate elements (the grid every wallet shows), which the whole-text rule alone let through.
  const BIP39 = new Set("abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo".split(" "));
  const PHRASE_MIN = 12;
  const NUMBERING = /^\(?\d{1,2}[.):]?$/;                                          // "1." "(2)" "3:" grid numbers
  // Lowercase as wallets show them, or ALL CAPS (a phrase written out loud): a Capitalised menu ("Home About Help ...") must not
  // read as a phrase, but "ABANDON ABILITY ..." must (audit 4).
  const bareWord = (t) => t.replace(/^\(?\d{1,2}[.):]/, "").replace(/^[("'\[]+|[.,;:!?)"'\]]+$/g, "");
  const isSeedWord = (t) => { const w = bareWord(t); return BIP39.has(w) || (w.length >= 3 && w === w.toUpperCase() && BIP39.has(w.toLowerCase())); };
  // Redact every run of >= 12 consecutive BIP39 words inside one string. Grid numbers inside the run are neutral.
  function redactPhraseRuns(s) {
    // Words joined by - _ , | / ; ("abandon-ability-...") are split too (audit 4).
    const toks = [...s.matchAll(/[^\s,;|/_-]+/g)];
    const cut = []; let start = -1, end = -1, n = 0;
    const close = () => { if (n >= PHRASE_MIN) cut.push([start, end]); start = -1; n = 0; };
    for (const m of toks) {
      if (NUMBERING.test(m[0])) { continue; }
      if (isSeedWord(m[0])) { if (start < 0) start = m.index; end = m.index + m[0].length; n++; }
      else close();
    }
    close();
    for (let i = cut.length - 1; i >= 0; i--) s = s.slice(0, cut[i][0]) + REDACTED + s.slice(cut[i][1]);
    return s;
  }
  // Across items in reading order (blocks, or control labels/values): which items belong to a run of >= 12 items that
  // are each ONE BIP39 word (optionally numbered). Number-only items between them are neutral. Returns a boolean per item.
  function phraseRunMask(texts) {
    const mask = texts.map(() => false);
    let run = [];
    const close = () => { if (run.length >= PHRASE_MIN) for (const i of run) mask[i] = true; run = []; };
    texts.forEach((t, i) => {
      const toks = String(t == null ? "" : t).trim().split(/\s+/).filter((x) => x && !NUMBERING.test(x));
      if (!String(t == null ? "" : t).trim()) return;            // empty: neutral
      if (toks.length === 0) return;                               // only a grid number: neutral
      if (toks.length === 1 && isSeedWord(toks[0])) run.push(i); else close();
    });
    close();
    return mask;
  }

  // Card numbers: 13 to 19 digits (spaces or dashes allowed) that pass the Luhn check. Random digit runs rarely do.
  const CARD = /\b[2-6]\d{3}(?:[ -]?\d){9,15}\b/g;
  function luhn(d) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let x = d.charCodeAt(d.length - 1 - i) - 48; if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
    return sum % 10 === 0;
  }

  // Aadhaar: 12 digits, first 2-9, with the Verhoeff check digit (so random 12-digit numbers rarely match).
  const AADHAAR = /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g;
  const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function verhoeff(d) { let c = 0; const a = d.split("").reverse().map(Number); for (let i = 0; i < a.length; i++) c = VD[c][VP[i % 8][a[i]]]; return c === 0; }
  // A secret said in words: "my password is hunter2", "OTP: 482913", "UPI PIN 4411". The label stays, the value goes. Ordinary
  // form messages ("Password is required", "PIN code") are left alone.
  const SPOKEN = /\b(password|passcode|passwd|pass phrase|passphrase|upi pin|m-?pin|atm pin|pin|otp|one[- ]time (?:code|password)|cvv|cvc|security code|verification code)\b(?:(\s*(?:is|was|=|:)\s*)(["']?)(?!(?:required|incorrect|invalid|wrong|too|missing|empty|not|must|weak|strong|needed|optional|expired|sent|valid|correct|case|at|a|an|the|your|my|code|number|field|below|above|here|on|for|to)\b)([^\s"',;]{2,}[^\s"',;.!?)\]])|(\s+)(\d{3,8})\b)/gi;
  function redactSpoken(s) {
    return s.replace(SPOKEN, (m, label, sep, q, val, sp, digits) => (val !== undefined ? label + sep + q + REDACTED : label + sp + REDACTED));
  }

  function isPhrase(s) {
    const w = s.trim().split(/\s+/).filter((t) => !/^\d{1,2}[.):]?$/.test(t)); // "1. word 2. word" numbered grids
    return [12, 15, 18, 21, 24].includes(w.length) && w.every((t) => /^[a-z]{3,10}$/.test(t));
  }

  // Replace secret-shaped substrings. A whole-text mnemonic is redacted whole; a mnemonic after "label:" keeps the label.
  function redactShapes(text) {
    let s = text;
    if (isPhrase(s)) return REDACTED;
    const i = s.lastIndexOf(":");
    if (i > -1 && isPhrase(s.slice(i + 1))) s = s.slice(0, i + 1) + " " + REDACTED;
    s = redactPhraseRuns(s);
    for (const re of SHAPES) s = s.replace(re, REDACTED);
    s = s.replace(CARD, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) ? REDACTED : m; });
    s = s.replace(AADHAAR, (m) => (verhoeff(m.replace(/\D/g, "")) ? REDACTED : m));
    s = redactSpoken(s);
    s = s.replace(LONG_RUN, (m) => (PUBLIC_ADDR.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m) ? m : REDACTED));
    return s;
  }

  // redact(text, ctx): the one gate every string passes before it leaves the tab. ctx is optional and describes the
  // FIELD the text came from: { type, autocomplete, text }. A secret field gives "[redacted]" whatever its value is.
  function redact(text, ctx) {
    const s = String(text == null ? "" : text);
    if (ctx && isSecretField(ctx)) return REDACTED;
    return redactShapes(s);
  }

  // ---- injection neutralizer ------------------------------------------------------------------------------------
  // The helper parses [POINT:id], [STEP n/m] and [WAIT] out of what the model writes, and fences page data with
  // <<..>> and ``` (section 5). Page text must never be able to spell any of them. Invisible characters are removed
  // FIRST so "[PO<zero-width>INT:" cannot slip through. Idempotent: running it twice changes nothing more.
  function neutralize(text) {
    return String(text == null ? "" : text)
      .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .replace(/\[\s*POINT\s*:/gi, "[ POINT :")
      .replace(/\[\s*STEP/gi, "[ STEP")
      .replace(/\[\s*WAIT\s*\]/gi, "[ WAIT ]")
      .replace(/<<+/g, "< <").replace(/>>+/g, "> >")
      .replace(/`{3,}/g, "` ` `");
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  // The text pipeline for anything that becomes block text, selection or a state value.
  const safeText = (s, max = BLOCK_MAX, ctx) => clip(clean(redact(neutralize(s), ctx)), max);

  // ---- tokens ---------------------------------------------------------------------------------------------------
  const estimateTokens = (s) => Math.ceil(String(s || "").length / 4);
  const blockTokens = (b) => estimateTokens(b.text) + 3; // + id and kind markers in the prompt

  // ---- blocks from text records ---------------------------------------------------------------------------------
  // The DOM layer (blocks.js) walks the page and emits one record per visible text node:
  //   { key, tag, cell, text, rect, inView, boiler, errorish }
  // key = the container element (records with the same key form one block), tag = its lowercase tag name, cell = the
  // td/th it sits in (rows only), boiler = inside nav/footer/aside, errorish = looks like an error message.
  // Everything after that is pure and lives here.
  function kindOf(tag) {
    if (/^h[1-6]$/.test(tag)) return "h";
    if (tag === "li") return "li";
    if (tag === "pre") return "code";
    if (tag === "tr") return "cell";
    if (tag === "figcaption" || tag === "caption") return "caption";
    if (["p", "blockquote", "dd", "dt", "summary"].includes(tag)) return "p";
    return "text";
  }

  function buildBlocks(records, opts) {
    const skip = new Set(((opts && opts.controlLabels) || []).map((l) => clean(l).toLowerCase()).filter(Boolean));
    const groups = new Map();
    for (const r of records) {
      let g = groups.get(r.key);
      if (!g) groups.set(r.key, (g = { tag: r.tag, rect: r.rect, inView: r.inView, boiler: !!r.boiler, errorish: !!r.errorish, parts: [], cells: [] }));
      if (r.tag === "tr") {
        const last = g.cells[g.cells.length - 1];
        if (last && last.key === r.cell) last.parts.push(r.text); else g.cells.push({ key: r.cell, parts: [r.text] });
      } else g.parts.push(r.text);
    }
    const out = [];
    for (const g of groups.values()) {
      let kind = kindOf(g.tag);
      let raw;
      if (g.tag === "tr") raw = "row: " + g.cells.map((c) => clean(c.parts.join(" "))).filter(Boolean).join(" | ");
      else if (kind === "code") raw = g.parts.join("\n");
      else raw = g.parts.join(" ");
      let text = kind === "code"
        ? clip(redact(neutralize(raw)).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(), BLOCK_MAX)
        : safeText(raw);
      if (g.errorish && kind !== "h") kind = "error";
      if (text.length < 2 || (kind === "text" && text.length < 3)) continue;
      out.push({ kind, text, inView: !!g.inView, rect: g.rect || undefined, boiler: g.boiler });
    }
    // A recovery phrase spread over 12+ elements (one word each) is redacted as a whole, before dedupe could hide the run.
    const mask = phraseRunMask(out.map((b) => b.text));
    out.forEach((b, i) => { if (mask[i]) b.text = REDACTED; });
    // Dedupe. A heading wins over any other block with the same words (a card title repeated in its link), and a
    // plain text/list block that only repeats a control's label adds nothing: the controls list already has it.
    const headings = new Set(out.filter((b) => b.kind === "h").map((b) => b.text.toLowerCase()));
    const seen = new Set();
    return out.filter((b) => {
      const k = b.text.toLowerCase();
      if (b.kind !== "h" && headings.has(k)) return false;
      if ((b.kind === "text" || b.kind === "li") && skip.has(k)) return false;
      if (b.kind !== "error" && seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---- budget ---------------------------------------------------------------------------------------------------
  // Order of keep: headings (the page map, capped at half the budget, on-screen first), errors, in-view blocks,
  // then the rest in reading order. Nav/footer boilerplate is only used if room is left over. Result keeps reading order.
  function trim(blocks, budgetTokens) {
    const all = blocks.map((b, i) => ({ b, i }));
    let left = budgetTokens;
    const keep = new Set();
    const take = (x) => { const c = blockTokens(x.b); if (c > left) return false; left -= c; keep.add(x.i); return true; };
    const heads = all.filter((x) => x.b.kind === "h");
    let headBudget = Math.floor(budgetTokens / 2);
    for (const x of [...heads.filter((x) => x.b.inView), ...heads.filter((x) => !x.b.inView)]) {
      const c = blockTokens(x.b);
      if (c > headBudget) continue;
      headBudget -= c; take(x);
    }
    const rest = all.filter((x) => x.b.kind !== "h");
    for (const x of rest.filter((x) => x.b.kind === "error")) take(x);
    const tiers = [
      rest.filter((x) => x.b.kind !== "error" && x.b.inView && !x.b.boiler),
      rest.filter((x) => x.b.kind !== "error" && !x.b.inView && !x.b.boiler),
      rest.filter((x) => x.b.kind !== "error" && x.b.boiler),
    ];
    for (const tier of tiers) for (const x of tier) { if (left < 8) break; take(x); }
    const kept = all.filter((x) => keep.has(x.i)).map((x) => x.b);
    return { blocks: kept, dropped: blocks.length - kept.length };
  }

  // Number the blocks "t0".. in their final order and drop the helper-only fields.
  function number(blocks) {
    return blocks.map((b, i) => {
      const o = { id: "t" + i, kind: b.kind, text: b.text, inView: b.inView };
      if (b.rect) o.rect = b.rect;
      return o;
    });
  }

  // Sanity-check a block that arrived from ANOTHER frame: its page is untrusted, so retype everything.
  const KINDS = new Set(["p", "h", "li", "code", "cell", "error", "caption", "text"]);
  function sanitizeForeign(b) {
    if (!b || typeof b !== "object") return null;
    const text = safeText(String(b.text == null ? "" : b.text));
    if (text.length < 2) return null;
    return { kind: KINDS.has(b.kind) ? b.kind : "text", text, inView: !!b.inView, boiler: !!b.boiler };
  }

  // ---- whole-context tokens -------------------------------------------------------------------------------------
  function contextTokens(ctx) {
    let n = estimateTokens(ctx.url) + estimateTokens(ctx.title) + estimateTokens(ctx.selection || "");
    for (const b of ctx.blocks) n += blockTokens(b);
    for (const c of ctx.controls) {
      n += estimateTokens(c.label) + 6;
      if (c.state) n += estimateTokens(JSON.stringify(c.state)) ;
      if (c.errorText) n += estimateTokens(c.errorText);
    }
    return n;
  }

  const api = { REDACTED, BLOCK_MAX, isSecretField, redact, redactShapes, phraseRunMask, neutralize, safeText, estimateTokens, blockTokens, buildBlocks, trim, number, sanitizeForeign, contextTokens, clean, clip };
  root.IsharaBlocks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
