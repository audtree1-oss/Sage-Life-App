// Day-one seed, taken from the Sage Full Day-One Context Export (July 29, 2026).
// The point of this file: Regena opens the app and it already knows her —
// her routines, her house, the lake, what's coming, what's waiting on what.
//
// Sensitive material is deliberately absent (spec §22): no passwords, no
// account data, no estate documents, no medical detail. Tasks that *refer*
// to those things are here; the secrets they refer to are not.

const YEAR = 2026;

// Evans, GA and Lake Greenwood, SC. Weather is fetched from these.
const LOCATIONS = [
  { key: 'evans', name: 'Evans', emoji: '🏡', lat: 33.5340, lon: -82.1307, is_home: 1 },
  { key: 'lake', name: 'The Other Place', emoji: '🍹', lat: 34.1793, lon: -82.1382, is_home: 0 },
  { key: 'patio_kitchen', name: 'Patio kitchen', emoji: '🌿', lat: 33.5340, lon: -82.1307, is_home: 0 },
];

const ROUTINES = [
  { name: 'Summer morning', emoji: '🌅', trigger_type: 'seasonal', sort: 1,
    trigger_config: { months: [5, 6, 7, 8, 9], time_of_day: 'morning' }, suppress_if: { on_trip: true },
    steps: ['Adjust thermostat', 'Water plants', 'Check hummingbird feeder'] },

  { name: 'Evening closing', emoji: '🌙', trigger_type: 'daily', sort: 2,
    trigger_config: { time_of_day: 'evening', after_hour: 19 },
    steps: ['Check exterior doors locked', 'Confirm gas stove/burners off', 'Confirm fireplace off',
      'Check sprinkler system', 'Check outdoor blinds', 'Check indoor blinds', 'Adjust thermostats',
      'Confirm evening meds taken; take if not'] },

  { name: 'Before leaving Evans for the lake', emoji: '🚗', trigger_type: 'event', sort: 3,
    trigger_config: { event: 'trip_departure' },
    steps: ['Hummingbird feeders full', 'Water plants', 'Pull blinds down', 'Adjust thermostats',
      'Adjust sprinkler system', 'Check under-house systems', 'Empty coffee-pot reservoir', 'Take trash out'] },

  { name: 'Before leaving the lake', emoji: '🏁', trigger_type: 'event', sort: 4,
    trigger_config: { event: 'trip_return' },
    cadence_note: 'What stays, what comes home — and write down what’s left in the fridge and pantry for next time.',
    steps: ['Decide what stays vs. comes home', 'Record lake refrigerator state', 'Record lake pantry state',
      'Pack cold and frozen items last'] },

  { name: 'Weekly water run', emoji: '🚿', trigger_type: 'flexible', sort: 5,
    trigger_config: { cadence: 'weekly' },
    cadence_note: 'Roughly weekly, no particular day. Never overdue.',
    steps: ['Run water in bathtub', 'Run water at bar', 'Run water in downstairs bathroom'] },

  { name: 'Patio kitchen check', emoji: '🌿', trigger_type: 'location', sort: 6,
    trigger_config: { location: 'patio_kitchen' },
    steps: ['Check/flush downstairs toilet', 'Check humidifier', 'Check air purifier'] },

  { name: 'Rain check', emoji: '🌧️', trigger_type: 'weather', sort: 7,
    trigger_config: { weather: 'rain' },
    steps: ['Check sump pump'] },

  { name: 'Before company arrives', emoji: '🫖', trigger_type: 'event', sort: 8,
    trigger_config: { event: 'hosting' },
    cadence_note: 'Day-of is best for freshness; the day before is fine.',
    steps: ['Guest bathroom clean'] },

  { name: 'Garbage to the street', emoji: '🗑️', trigger_type: 'weekly', sort: 9,
    trigger_config: { days: [1], time_of_day: 'evening', after_hour: 18 },
    cadence_note: 'After 6 PM — so it isn’t blocking the street while people are driving home.',
    steps: ['Bin to the street'] },

  { name: 'Home PT', emoji: '🧘', trigger_type: 'daily', sort: 10,
    trigger_config: { time_of_day: 'any' }, suppress_if: { event_kind: 'pt' },
    cadence_note: 'Two rounds a day — none on a PT appointment day.',
    steps: ['PT round 1', 'PT round 2'] },

  { name: 'Quarterly house check', emoji: '🔧', trigger_type: 'flexible', sort: 11,
    trigger_config: { cadence: 'quarterly' },
    cadence_note: 'Every few months, whenever it suits.',
    steps: ['Lights', 'Under-house humidifier', 'Under-house air purifier', 'Other periodic checks'] },
];

// Events with real dates from §21.
const EVENTS = [
  { title: 'PT appointment', event_start: `${YEAR}-07-30T09:30`, event_kind: 'pt', importance: 'must' },
  { title: 'Birthday dinner', event_start: `${YEAR}-08-10T18:00`, event_kind: 'other', importance: 'must',
    note: 'Gifts need to be chosen and bought before this.' },
  { title: '5 O’Clock Somewhere', event_start: `${YEAR}-08-21T17:00`, event_kind: 'other' },
  { title: '5 O’Clock Somewhere — group at the lake', event_start: `${YEAR}-09-11T17:00`,
    event_kind: 'hosting', location: 'lake', importance: 'must',
    note: 'Hosting at the lake — prep wakes up beforehand.' },
];

const TRIPS = [
  { location_key: 'lake', start_date: `${YEAR}-07-31`, end_date: `${YEAR}-08-02`,
    note: 'Friday morning departure, Sunday late-afternoon return.' },
];

// Near-term tasks (§10), projects and their next actions (§11), house backlog
// (§12). `key` lets a later item point at this one as a prerequisite.
const ITEMS = [
  // --- near-term ---
  { title: 'Pay Terminix', type: 'task', importance: 'must', due_at: `${YEAR}-07-30`,
    note: 'Today if convenient, tomorrow otherwise.', life_area: 'admin' },
  { title: 'Call to change the August 24 appointment', type: 'task', importance: 'must',
    due_at: `${YEAR}-08-03`, life_area: 'admin' },
  { title: 'Plan lake food and packing for Friday', type: 'task', importance: 'must',
    due_at: `${YEAR}-07-30`, location: 'lake', life_area: 'lake',
    note: 'Most of it can be staged Thursday night; fridge and freezer items go in Friday morning.' },
  { title: 'Choose and buy birthday gifts — Thelma, Pam, Brenda, Manisha', type: 'task',
    importance: 'must', due_at: `${YEAR}-08-10`, life_area: 'people',
    note: 'Sage can help decide. Crowded stores are unattractive — online or a quiet errand is better.' },
  { title: 'Amazon hat return — drop at UPS', type: 'task', importance: 'must', due_at: `${YEAR}-08-14`,
    store: 'UPS Store', life_area: 'errands',
    note: 'Label is already printed. The UPS Store next to Publix pairs well with a Publix trip.' },
  { title: 'Find and make a gynecologist appointment', type: 'task', importance: 'should', life_area: 'health' },
  { title: 'Schedule Lexus Butler service, and find out what warranty is left', type: 'task',
    importance: 'should', life_area: 'admin' },
  { title: 'Corn on foot — decide what to do and follow through', type: 'task', importance: 'should',
    life_area: 'health' },
  { title: 'Figure out how to use the new Jar Genie', type: 'opportunity', importance: 'opportunity',
    effort_min: 20, life_area: 'kitchen' },
  { title: 'Clean out freezer items over a year old', type: 'task', importance: 'should',
    effort_min: 45, life_area: 'kitchen' },
  { title: 'Get a laundry sink for the lake', type: 'task', importance: 'should', location: 'lake', life_area: 'lake' },
  { title: 'Get screen-repair material', type: 'task', importance: 'should', life_area: 'house' },
  { title: 'Costco returns', type: 'task', importance: 'should', target_window: 'by May 2027',
    window_start: `${YEAR + 1}-03-01`, store: 'Costco', life_area: 'errands',
    note: 'Can wait — but must not disappear. Internal target May 2027.' },

  // --- projects ---
  { key: 'sewing', title: 'Learn to sew', type: 'project', importance: 'should', life_area: 'hobbies',
    outcome: 'Comfortable enough with the new machine to take on small projects.',
    next_action: 'Find a place to set the machine up' },
  { title: 'Find a place to set the sewing machine up', type: 'task', importance: 'should',
    project_key: 'sewing', effort_min: 30, life_area: 'hobbies' },
  { key: 'sewing_setup', title: 'Open the new machine and read the manual', type: 'task',
    importance: 'should', project_key: 'sewing', effort_min: 45, life_area: 'hobbies' },
  { title: 'Hem the pink bedroom curtains', type: 'task', importance: 'should',
    prereq_keys: ['sewing_setup'], life_area: 'house',
    note: 'Waits until the machine is set up and familiar.' },

  { key: 'jewelry', title: 'Organize the costume jewelry', type: 'project', importance: 'opportunity',
    life_area: 'house', effort_min: 30,
    outcome: 'Everything in the designated drawer, findable.',
    next_action: 'Order one more organizer set',
    note: 'Gradual. An opportunity on a light day — never a daily obligation.' },
  { title: 'Order one more jewelry organizer set', type: 'shopping', importance: 'opportunity',
    project_key: 'jewelry', purchase_rule: 'now', life_area: 'house' },

  { title: 'Tripoley August dinner — easy menu with advance prep', type: 'project', importance: 'should',
    due_at: `${YEAR}-08-15`, life_area: 'hosting',
    outcome: 'A menu that is mostly done before anyone arrives.',
    next_action: 'Pick three dishes that can be made ahead',
    note: 'Menu decisions are a known procrastination trigger — deciding early is the whole trick.' },

  { title: 'Mahjong practice', type: 'opportunity', importance: 'opportunity', effort_min: 30,
    life_area: 'hobbies', note: 'With the set at home. No streaks, no guilt — plays weekly regardless.' },

  { title: 'Cards — thank-you, birthday, sympathy', type: 'project', importance: 'should',
    life_area: 'people',
    outcome: 'Cards actually get sent, without a decision every time.',
    next_action: 'Look into personalized stationery',
    note: 'Choosing the perfect card is the friction. A stack of good blank ones removes it. A late sympathy card still matters.' },

  { title: 'Getting healthy food to the shop', type: 'project', importance: 'should', life_area: 'family',
    outcome: 'A rhythm that works without nagging anyone.',
    next_action: 'Decide what travels well and how often' },

  { title: 'Garden system', type: 'project', importance: 'should', life_area: 'garden',
    outcome: 'Know what is planted, what it needs, and when.',
    next_action: 'List what is already in the beds',
    note: 'Zone 8b. Wet strip in front of the canna lilies (about 2×30 ft, sun mid-morning to late day, stays moist — pollinator planting would suit). Two camellias bloomed this year for once. Variegated Asiatic jasmine is the idea for the bare area under the crape myrtle. David’s mother’s rose is tracked. Wants a winter/spring bulb plan with timing and placement.' },

  { title: 'House maintenance records', type: 'project', importance: 'should', life_area: 'house',
    outcome: 'Warranties and maintenance history in one findable place.',
    next_action: 'Gather the warranty paperwork that exists' },

  { title: 'Masters rental prep', type: 'project', importance: 'should',
    target_window: 'well before April', window_start: `${YEAR + 1}-01-05`, life_area: 'house',
    outcome: 'House ready without a scramble.',
    next_action: 'Decide whether to use Audrey’s app for it' },

  { title: 'Life and estate readiness', type: 'project', importance: 'should', life_area: 'admin',
    outcome: 'The important things decided and findable by family.',
    next_action: 'Update the beneficiary',
    note: 'Sage tracks the tasks only. Documents and account details stay out of here on purpose.' },
  { title: 'Update the beneficiary', type: 'task', importance: 'should', life_area: 'admin',
    note: 'The task lives here. The account details do not.' },

  { title: 'Password access for emergencies', type: 'project', importance: 'should', life_area: 'admin',
    outcome: 'David knows where the list is; there is a sane emergency path.',
    next_action: 'Update David’s list and confirm where it lives',
    note: 'No actual passwords in Sage — ever.' },

  { title: 'Recipe system', type: 'project', importance: 'opportunity', life_area: 'kitchen',
    outcome: 'One place that knows which recipes are keepers.',
    next_action: 'Decide what belongs in Paprika vs. here vs. paper',
    note: 'Keepers so far: protein breakfast bars · East-African lentil salad · broccoli slaw salad · light ranch · venison broth bowl · egg tortilla pan · warm slaw & eggs · air-fryer chicken nuggets · lake breakfast pancakes · guacamole · blueberry-pecan freezer muffins · brothy broccoli slaw bowl · fresh basil micro-pesto · basil-pesto chicken salad.' },

  { title: 'Meal planning and the grocery-ad workflow', type: 'project', importance: 'opportunity',
    life_area: 'kitchen',
    outcome: 'Meals planned without setup and typing becoming the project.',
    next_action: 'Try one week the lazy way and see what breaks' },

  // --- house / property backlog (§12) ---
  { title: 'Replace the window', type: 'task', importance: 'should', target_window: 'September',
    window_start: `${YEAR}-09-01`, life_area: 'house' },
  { title: 'Attic insulation', type: 'task', importance: 'should',
    target_window: 'cool, dry weather (Oct–Nov)', window_start: `${YEAR}-10-01`, life_area: 'house' },
  { title: 'Fix the grouting at the front steps and back porch', type: 'task', importance: 'should', life_area: 'house' },
  { title: 'Finish waterproofing under the foundation', type: 'task', importance: 'should', life_area: 'house' },
  { title: 'Replace the bird watering dish with a non-metal one', type: 'opportunity',
    importance: 'opportunity', effort_min: 15, life_area: 'garden' },
  { title: 'Find a better hummingbird feeder', type: 'opportunity', importance: 'opportunity',
    effort_min: 20, life_area: 'garden' },
  { title: 'Deep clean the old Maytag', type: 'task', importance: 'should', life_area: 'house',
    note: 'One-time intensive musty-odor clean. The ~10-year-old Maytag, not the new LG.' },
  { title: 'Garden work — pot, repot, divide, deadhead', type: 'opportunity', importance: 'opportunity',
    effort_min: 60, life_area: 'garden', eligibility: { weather: 'not_rain', max_temp: 88 },
    note: 'Waits for weather that isn’t punishing.' },

  // --- lake (§8) ---
  { title: 'Decide what the outdoor kitchen actually needs', type: 'project', importance: 'should',
    location: 'lake', life_area: 'lake',
    outcome: 'The outdoor kitchen is self-sufficient without hauling things back and forth.',
    next_action: 'Finish the kitchen, then inventory what’s missing',
    note: 'Each kitchen reasonably self-sufficient — deliberate duplicates are fine (three instant-read thermometers, one per kitchen). Don’t move excess to the lake before knowing the space and the need.' },
  { title: 'Buoy to mark the swim zone', type: 'opportunity', importance: 'opportunity',
    location: 'lake', life_area: 'lake', note: 'Swim area near the dock runs about 12 ft deep.' },
  { title: 'Stock one first-aid kit for the lake', type: 'shopping', importance: 'should',
    location: 'lake', life_area: 'lake', purchase_rule: 'now',
    note: 'My Medic MyFAK preferred, with the saline eye wash add-on.' },

  // --- opportunities (§14, §15) ---
  { title: 'Publix senior day — 5% off', type: 'opportunity', importance: 'opportunity',
    eligibility: { days: [3] }, store: 'Publix', life_area: 'errands',
    note: 'Wednesdays. An opportunity when shopping is relevant — not an obligation every week.' },
  { title: 'Use the cantaloupe', type: 'opportunity', importance: 'opportunity', effort_min: 10,
    life_area: 'kitchen', note: 'Could go to the lake.' },
  { title: 'Pears — use or preserve', type: 'opportunity', importance: 'opportunity', effort_min: 30, life_area: 'kitchen' },
  { title: 'Use the broccoli', type: 'opportunity', importance: 'opportunity', effort_min: 15, life_area: 'kitchen' },
  { title: 'Avocados — use or freeze', type: 'opportunity', importance: 'opportunity', effort_min: 10, life_area: 'kitchen' },
];

// §14 — watch, don't nag. Escalates on its own as things run out.
const INVENTORY = [
  { name: 'Dawn dish detergent', location_key: 'evans', state: 'low', purchase_rule: 'on_sale',
    store: 'Costco', note: 'Wait for a Costco sale unless it gets close to empty.' },
  { name: 'Kitchen garbage bags', location_key: 'evans', state: 'ok', purchase_rule: 'on_sale',
    store: 'Costco', note: 'Costco sale-watch unless nearly out.' },
  { name: 'Kirkland fragrance-free baby wipes', location_key: 'evans', state: 'ok', purchase_rule: 'low',
    store: 'Costco', note: 'David can pick these up — send him the saved product photo.' },
];

// Her Subscriptions list, moved across from Apple Reminders on July 30, 2026.
// iCloud will not share that list with other apps, so it was read from a
// screenshot and typed in here rather than synced.
//
// Two of her reminders carry account identifiers — an AARP membership number
// and a Terminix account number. Those are deliberately not here (spec §12/§22);
// each note says where they still live. Everything else is kept as she wrote it,
// with `raw` holding her original line word for word.
const SUBSCRIPTIONS = {
  project: {
    title: 'Subscriptions & renewals', type: 'project', life_area: 'subscriptions',
    outcome: 'Nothing renews, lapses or surprises me without my knowing first.',
    note: 'Moved over from the Subscriptions list in Reminders.',
  },
  items: [
    { title: 'AARP renews — $16', due_at: '2026-09-30', importance: 'should',
      raw: 'aarp  auto renewal, $16 — 9/30/26, Yearly',
      note: 'Yearly, on auto renewal. The membership number stays in your Reminders list.' },

    { title: 'Norton renews', due_at: '2027-01-29', importance: 'should',
      raw: 'norton renewal 2/2 — 1/29/27, Yearly', note: 'Yearly.' },

    { title: 'Frndly renews', due_at: '2027-10-01', importance: 'should',
      raw: 'frndly auto renew 10/5/25 — 10/1/27, Yearly',
      note: 'Yearly, on auto renewal. Last renewal noted as 10/5/25.' },

    { title: 'Fishing licence — expired 7/4/2026', due_at: '2026-06-04', importance: 'must',
      raw: 'fishing liscemse expires 7/4/2026 — 6/4/26',
      note: 'The expiry date on this one has already passed. Worth checking before the next lake trip.' },

    { title: 'Roach spray at the camper', due_at: '2026-09-17', importance: 'should',
      raw: 'quarterly roach spray at Camper — 9/17/26, Every 3 months', note: 'Every 3 months.' },

    { title: 'Dermalogica subscription — the 21st', due_at: '2026-08-14', importance: 'must',
      raw: '!!! dermalogica subscription 21st — 8/14/26, Every 3 months. spf moisturizer, cleansing, night moisterizer',
      note: 'Every 3 months: SPF moisturiser, cleansing, night moisturiser. You had this flagged high priority.' },

    { title: 'Call Rollo — birthday', due_at: '2026-09-05T12:00', importance: 'should',
      raw: 'Call Rollo BDay! — 9/5/26, 12:00 PM, Yearly', note: 'Yearly.' },

    { title: 'Paramount+ ends — $89 a year', due_at: '2027-02-25T10:00', importance: 'should',
      raw: 'Paramount+ subscription ends March 8, 2027. Current plan $89 a year. — 2/25/27, 10:00 AM, Weekly',
      note: 'Plan ends March 8, 2027. The reminder was set to repeat weekly, which looks unintended.' },

    { title: 'HBO Max — monthly', importance: 'should',
      raw: 'hbo max monthly', note: 'Monthly. The original reminder had no renewal date on it.' },

    { title: 'Terminix — 8/2026 through 7/2027', due_at: '2026-08-30', importance: 'should',
      raw: 'terminix acct. [number], 368.6 3%, 8/2026 through7/2027 — 8/30/26, Yearly',
      note: 'Yearly. Written on the original as "368.6 3%". The account number stays in your Reminders list.' },
  ],
};

// Stable operating context the reasoning layer is given every time (§2, §16, §20).
const PREFERENCES = {
  home_location: 'evans',
  lake_name: 'The Other Place',
  partner: 'David',
  decision_principle: 'Could improve ≠ needs improvement. Possibility does not automatically become obligation.',
  purchase_question: 'What would this add that the current ones don’t?',
  deferral_note: 'A deferred task is not automatically avoidance — weather, location, prerequisites and real priority all count.',
  friction_areas: 'party menus and potlucks, gift selection, book-club reading, cards, some admin, keeping systems updated after setup',
  strengths: 'once a simple system works, consistency is good — bills paid as they arrive, budget maintained, Tripoley list kept current',
  goal: 'Lower cognitive load, fewer forgotten commitments, more intentional attention. Not maximum productivity.',
};

module.exports = { LOCATIONS, ROUTINES, EVENTS, TRIPS, ITEMS, INVENTORY, SUBSCRIPTIONS, PREFERENCES };
