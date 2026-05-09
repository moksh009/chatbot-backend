/**
 * Apex Light — owner support flow (Hdmi 2.1 & 2.0 FAQ PDF + catalogue).
 * WhatsApp limits: max 3 reply buttons per message; list messages max 10 rows total
 * across all sections (engine slices in dualBrainEngine). Sticky nodes are editor-only (no edges).
 */

const FLOW_ID = 'flow_apex_owner_support_hub_v1';
const FLOW_NAME = 'Apex Light — Owner Support & Catalogue';
const FLOW_DESCRIPTION =
  'PDF-aligned support: purchased vs purchase path, HDMI 2.1/2.0 guides, troubleshoot, warranty, Shopify order lookup, WhatsApp catalogue.';

/** Long-form answers — sourced from client HDMI 2.1 / 2.0 FAQ document */
const COPY = {
  buyIntro: `Thanks for choosing *Apex Light*!

If you want to *purchase* or have *questions before you buy*, message or call us on *9328613239* — we reply fastest there.

Right after this message you can also *open our WhatsApp catalogue* to see products with images and add to cart (enable Meta Catalog under Settings → Commerce if needed).`,

  m21_install: `*Apex HDMI 2.1 TV Backlight* (up to 90")

*Installation video:* https://youtu.be/b82bLHryIxM?feature=shared

*App:* Smart Life (SmartLife)

*LED strips:* The box has *two* LED strips. You should install *both*. You can start from the *left bottom* or *right bottom* (facing the TV from the back). Cut *only* on the *white dotted lines* between the *three copper dots*.

*Direction / colours look wrong:* Try swapping the *USB cables* of the two strips on the sync box. If it persists, open Smart Life → setup → *change direction* (e.g. left-to-right vs right-to-left).`,

  m21_strip: `*Strip issues (HDMI 2.1)*

*Only half the strip glows:* Restart the sync box (button on the back — hold ~10s until LEDs blink). After cutting to your TV size, power-cycle if needed.

*Restart sequence (follow in order):*
1) Hold sync box button ~10s
2) Turn power off
3) Remove all connections
4) Connect *both* strip USB cables first
5) HDMI source → *HDMI IN* on sync box
6) HDMI *OUT* → TV
7) Adapter last, then power on

*Cutting:* You *must* cut to your TV size so the sync box learns the size. Cut only at the white dotted lines between the yellow/copper dots.

*Leftover strip:* Keep it — you can solder later for a larger TV.

*Only one HDMI cable in box?* Yes — that cable goes from *HDMI OUT* on the sync box to the TV. The cable from your external device goes to sync box *HDMI IN* instead of directly to the TV.`,

  m21_hdmi: `*HDMI & syncing (2.1)*

*Playing video but not syncing?* Connect an *external device* (PlayStation, Apple TV, Fire Stick, STB) to sync box *HDMI IN*, and *HDMI OUT* to the TV — then play from that device.

*Important:* HDMI TV backlights on the market *do not sync with built-in smart TV apps* — use an external HDMI source through the sync box.

*Two devices on one HDMI IN?* *No* — only one device at a time. Use an *HDMI switch/splitter* if you must share sources.

*"No device found":* Restart using the HDMI-first sequence (HDMI IN → HDMI OUT → strip USB → adapter last). Try another TV HDMI port if it continues. Swap HDMI cables one at a time if you have spares.

*Half strip after cutting:* Retry the full restart sequence in order — connect *HDMI IN first*, then HDMI OUT, then strip USB, adapter last.`,

  m21_wifi: `*Smart Life / Wi‑Fi (2.1)*

Pair on *2.4 GHz* Wi‑Fi. Use the *same network* on the phone and inside the app.

If your router hides 2.4 GHz, use another phone as a *hotspot*, connect both the phone Wi‑Fi and the app to that hotspot — usually only needed for first setup.`,

  m21_restart: `*Full reboot sequence (2.1)* — do in exact order:

1) Hold button behind sync box ~10s (LEDs blink)
2) Turn off power
3) Unplug everything
4) Connect both strip USB cables
5) HDMI IN from your source device
6) HDMI OUT to TV
7) Adapter / power on

If problems remain: change the TV HDMI port for the OUT cable; then try replacing HDMI cables one at a time.`,

  m20_install: `*Apex HDMI 2.0 TV Backlight* & *2.0 + Bar* (up to 90")

*Installation video:* https://youtu.be/iPyzkp_guTA?feature=shared

*App:* Smart Life

*Bar kit:* If you bought the kit without the bar, your setup has no bar lights — everything else matches the video.

*Where to stick:* Start from the *bottom-left* (facing the TV from the *back*), then go *clockwise*. This product is designed to work *only* this way — you cannot start from the right for this model.`,

  m20_strip: `*Strip & cutting (2.0)*

*Cutting:* *Required* for correct sync. If you don't cut, the box assumes a *90"* layout. Cut only on white dotted lines between the three yellow/copper dots.

*Leftover strip:* Keep it for possible future solder/extension.

*Cable in box:* One HDMI cable supplied — HDMI OUT (sync box) → TV; your device's cable goes to sync box HDMI IN.

*Half strip glowing after cutting:* Restart: hold green button ~10s, power off, disconnect all, then reconnect in order: HDMI IN → HDMI OUT → strip USB in belt ports → adapter → power. Follow every step in sequence.

*"No device":* Same restart sequence; then try alternate TV HDMI inputs and swapping HDMI cables individually.`,

  m20_hdmi: `*Syncing rules (2.0)* — same family behaviour as 2.1:

Use an external HDMI source through sync box (*IN* ← device, *OUT* → TV). Built-in smart TV apps will *not* drive colour sync.

*Single HDMI IN only* — for multiple consoles/sources use a switch/splitter.`,

  m20_wifi: `*Smart Life / Wi‑Fi (2.0)*

Always use *2.4 GHz*, same SSID on phone and in the app. Hotspot workaround applies if dual-band routers hide 2.4 GHz.`,
  m20_restart: `*Reboot sequence (2.0)* — order matters:

Restart with button hold (~10s) → remove power → unplug all → HDMI IN → HDMI OUT → strip USB cables → adapter → power.

For *PlayStation blackouts / flicker:* turn off *VRR* and *HDR* in PS settings; try *4:2:0* colour format if the issue persists.`,

  tr_nosync: `*Not syncing*

1) Confirm *external HDMI source* flows: device → sync box HDMI *IN*, sync box HDMI *OUT* → TV.
2) Remember: *no sync* from TV's *built-in* Netflix/YouTube apps — use Fire Stick, console, Apple TV, etc.
3) Retry the full cable order from the FAQ (especially HDMI IN before OUT).`,

  tr_half: `*Half strip / only part glowing*

After cutting to size, do a full power cycle and reconnect in *sequence*: HDMI IN → HDMI OUT → strip USB → power last.

For 2.0 follow the green-button reset steps from the FAQ pack. Still stuck — send a short video on *9328613239*.`,

  tr_wifi: `*App won't connect*

Use *2.4 GHz Wi‑Fi* only; phone and Smart Life must be on that same network. Try a mobile hotspot once if your mesh router blocks 2.4 GHz.`,
  tr_colors: `*Colours wrong / opposite direction*

*2.1:* Swap the two strip USB plugs on the sync box; then toggle *direction* in Smart Life strip setup.

*2.0:* Direction is fixed by the *bottom-left clockwise* install path — if strips were started wrong, redo placement per the video.`,

  tr_ps5: `*Screen flicker with PlayStation*

Disable *VRR* and *HDR* in PS video settings; set HDMI to *4:2:0* if flashing continues. Confirm HDMI cables are rated for your setup.`,

  tr_cables: `*"No signal" / handshake issues*

Reconnect in FAQ order; try another TV HDMI port for *OUT*; swap HDMI cables one at a time. Message us with photos of cable routing if unresolved.`,

  other_products: `For *Monitor Sync*, lamps, neon, strips (non-TV-backlight), Govee co-branded lines, or *Stream Dock*, our team gives model-specific advice.

Please message or call *9328613239* with your *exact product name* and a photo of the label. You can also browse the *catalog* from the main menu.`,

  govee_misc: `For *Govee TV Backlight 3 Lite*, *Govee RGBIC TV Light Bars*, and *Apex Stream Dock*, tell us the *exact model/size* on *9328613239* so we can route you to the right guide.`,
};

function sticky(id, x, y, text, label = 'Implementation note') {
  return {
    id,
    type: 'sticky',
    position: { x, y },
    data: { label, text },
  };
}

function buildFlow() {
  const nodes = [
    sticky(
      'note_pdf',
      -420,
      -300,
      'Content basis: client FAQ "Hdmi 2.1 & hdmi 2.0" — install videos, Smart Life/Wi‑Fi rules, cabling order, splitter note, PS5 flicker/VRR tip, warranty/order paths.',
      '📄 PDF reference'
    ),
    sticky(
      'note_wa_limits',
      -420,
      -40,
      'WhatsApp allows max *3 buttons* per message — this flow uses lists (≤10 rows each) plus 3-button entry. Duplicate list row IDs across the graph confuse routing — all IDs here are unique.',
      '⚠️ WhatsApp limits'
    ),
    sticky(
      'note_catalog',
      -420,
      200,
      '*Catalog node* needs Meta Catalogue ID (+ Shopify sync). If missing, user gets Commerce setup hint text.',
      '🛒 Catalogue'
    ),

    {
      id: 'n_trigger',
      type: 'trigger',
      position: { x: 80, y: 120 },
      data: {
        label: 'Entry — Apex Light',
        triggerType: 'first_message',
        trigger: { type: 'first_message', channel: 'whatsapp' },
      },
    },
    {
      id: 'n_entry',
      type: 'interactive',
      position: { x: 420, y: 120 },
      data: {
        label: 'STEP 1 — Purchased?',
        interactiveType: 'button',
        header: 'Apex Light',
        text:
          'Hi! Have you *already purchased* our product, or do you want to *buy / ask about a product*?\n\nYou can also open the *full service menu*.',
        buttonsList: [
          { id: 'ent_have', title: 'I already own one' },
          { id: 'ent_buy', title: 'Buy or product info' },
          { id: 'ent_help', title: 'All services menu' },
        ],
      },
    },
    {
      id: 'n_buy_intro',
      type: 'message',
      position: { x: 780, y: 0 },
      data: { label: 'Purchase / pre-sales (PDF path B)', text: COPY.buyIntro },
    },
    {
      id: 'n_catalog',
      type: 'catalog',
      position: { x: 1080, y: 0 },
      data: {
        label: 'WhatsApp catalogue',
        body: 'Browse Apex products below. Tap any item for details — add to cart to check out when checkout is enabled.',
        text: 'Browse Apex products below. Tap any item for details — add to cart to check out when checkout is enabled.',
        catalogType: 'full',
      },
    },
    {
      id: 'n_have_pick',
      type: 'interactive',
      position: { x: 780, y: 220 },
      data: {
        label: 'STEP 2 — Which product? (1/3)',
        interactiveType: 'list',
        buttonText: 'See models',
        text: 'Choose the product you *already have* (page 1 of 3):',
        sections: [
          {
            title: 'Your Apex model',
            rows: [
              { id: 'p1_hdmi21', title: 'HDMI 2.1 TV Backlight', description: 'Up to 90"' },
              { id: 'p1_hdmi20', title: 'HDMI 2.0 TV Backlight', description: 'Up to 90"' },
              { id: 'p1_hdmi20b', title: 'HDMI 2.0 + Bar kit', description: 'Up to 90"' },
              { id: 'p1_mon', title: 'Monitor Sync collection', description: 'Monitor / bar / lamp' },
              { id: 'p1_floor', title: 'RGBICW floor lamp', description: '' },
              { id: 'p1_table', title: 'RGBCW table lamp', description: '' },
              { id: 'p1_neon', title: 'RGBIC Neon rope', description: '3m / 5m' },
              { id: 'p1_uplift', title: 'Uplighter floor lamp', description: '' },
              { id: 'p1_strip5', title: 'RGBIC LED Strip 5m', description: '' },
              { id: 'p1_more', title: '➜ More models', description: 'Page 2' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_have_pick2',
      type: 'interactive',
      position: { x: 780, y: 420 },
      data: {
        label: 'STEP 2 — Which product? (2/3)',
        interactiveType: 'list',
        buttonText: 'See models',
        text: 'More models you may own:',
        sections: [
          {
            title: 'Apex catalogue',
            rows: [
              { id: 'p2_cob', title: 'RGBIC COB strip 5m', description: '' },
              { id: 'p2_pixel', title: 'Pixel Display', description: '32² / 64²' },
              { id: 'p2_edge', title: 'Edge Neon 3m', description: '' },
              { id: 'p2_fls', title: 'Floor lamp + speaker', description: '' },
              { id: 'p2_game', title: 'Gaming light bars', description: '' },
              { id: 'p2_curtain', title: 'Curtain light 2×2m', description: '' },
              { id: 'p2_deskneon', title: 'Neon rope for desk 3m', description: '' },
              { id: 'p2_star', title: 'Star projector Pro', description: '' },
              { id: 'p2_wall', title: 'Smart Wall Light Line', description: '6 / 9 lines' },
              { id: 'p2_more', title: '➜ More models', description: 'Page 3' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_have_pick3',
      type: 'interactive',
      position: { x: 780, y: 620 },
      data: {
        label: 'STEP 2 — Which product? (3/3)',
        interactiveType: 'list',
        buttonText: 'See models',
        text: 'Final models + Govee co-branded lines:',
        sections: [
          {
            title: 'More products',
            rows: [
              { id: 'p3_out', title: 'Smart outdoor bulb', description: '' },
              { id: 'p3_gtv', title: 'Govee TV Backlight 3 Lite', description: '' },
              { id: 'p3_gbar', title: 'Govee RGBIC TV bars', description: '' },
              { id: 'p3_dock', title: 'Apex Stream Dock', description: '' },
              { id: 'p3_back', title: '⬆ Back to start', description: '' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_svc_menu',
      type: 'interactive',
      position: { x: 780, y: -180 },
      data: {
        label: 'All services — list menu',
        interactiveType: 'list',
        buttonText: 'Choose',
        text: 'Pick a service:',
        sections: [
          {
            title: 'Apex Light support hub',
            rows: [
              { id: 'svc_cat', title: 'Browse catalogue', description: 'Product cards' },
              { id: 'svc_war', title: 'Warranty status', description: '' },
              { id: 'svc_inst', title: 'Install help', description: 'uses last order' },
              { id: 'svc_fix', title: 'Troubleshoot', description: '' },
              { id: 'svc_ord', title: 'Order status', description: '' },
              { id: 'svc_human', title: 'Talk to a human', description: '' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_hub21',
      type: 'interactive',
      position: { x: 1180, y: 180 },
      data: {
        label: 'HDMI 2.1 — topic menu',
        interactiveType: 'list',
        buttonText: 'Topics',
        text: '*Apex HDMI 2.1 TV Backlight* — what do you need?',
        sections: [
          {
            title: 'Guides',
            rows: [
              { id: 'h21_vid', title: 'Install video & basics', description: '' },
              { id: 'h21_strip', title: 'LED strip & cutting', description: '' },
              { id: 'h21_hdmi', title: 'HDMI / no sync', description: '' },
              { id: 'h21_wifi', title: 'Smart Life / Wi‑Fi', description: '' },
              { id: 'h21_reset', title: 'Full reboot steps', description: '' },
              { id: 'h21_back', title: 'Pick another model', description: '' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_hub20',
      type: 'interactive',
      position: { x: 1180, y: 420 },
      data: {
        label: 'HDMI 2.0 — topic menu',
        interactiveType: 'list',
        buttonText: 'Topics',
        text: '*Apex HDMI 2.0* / *2.0 + Bar* — pick a topic:',
        sections: [
          {
            title: 'Guides',
            rows: [
              { id: 'h20_vid', title: 'Install video & basics', description: '' },
              { id: 'h20_strip', title: 'Strip rules & resets', description: '' },
              { id: 'h20_hdmi', title: 'HDMI / sync rules', description: '' },
              { id: 'h20_wifi', title: 'Smart Life / Wi‑Fi', description: '' },
              { id: 'h20_reset', title: 'Reset & PS flicker tip', description: '' },
              { id: 'h20_back', title: 'Pick another model', description: '' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_m21a',
      type: 'message',
      position: { x: 1560, y: 120 },
      data: { label: '2.1 — install/video', text: COPY.m21_install },
    },
    {
      id: 'n_m21b',
      type: 'message',
      position: { x: 1560, y: 260 },
      data: { label: '2.1 — strip', text: COPY.m21_strip },
    },
    {
      id: 'n_m21c',
      type: 'message',
      position: { x: 1560, y: 400 },
      data: { label: '2.1 — hdmi', text: COPY.m21_hdmi },
    },
    {
      id: 'n_m21d',
      type: 'message',
      position: { x: 1560, y: 540 },
      data: { label: '2.1 — wifi', text: COPY.m21_wifi },
    },
    {
      id: 'n_m21e',
      type: 'message',
      position: { x: 1560, y: 680 },
      data: { label: '2.1 — restart', text: COPY.m21_restart },
    },
    {
      id: 'n_m20a',
      type: 'message',
      position: { x: 1560, y: 820 },
      data: { label: '2.0 — install/video', text: COPY.m20_install },
    },
    {
      id: 'n_m20b',
      type: 'message',
      position: { x: 1560, y: 960 },
      data: { label: '2.0 — strip', text: COPY.m20_strip },
    },
    {
      id: 'n_m20c',
      type: 'message',
      position: { x: 1560, y: 1100 },
      data: { label: '2.0 — hdmi', text: COPY.m20_hdmi },
    },
    {
      id: 'n_m20d',
      type: 'message',
      position: { x: 1560, y: 1240 },
      data: { label: '2.0 — wifi', text: COPY.m20_wifi },
    },
    {
      id: 'n_m20e',
      type: 'message',
      position: { x: 1560, y: 1380 },
      data: { label: '2.0 — restart/PS', text: COPY.m20_restart },
    },
    {
      id: 'n_other_line',
      type: 'message',
      position: { x: 1180, y: 860 },
      data: { label: 'Non-HDMI-backlight guidance', text: COPY.other_products },
    },
    {
      id: 'n_govee_line',
      type: 'message',
      position: { x: 1180, y: 1000 },
      data: { label: 'Govee / Dock line', text: COPY.govee_misc },
    },
    {
      id: 'n_warranty',
      type: 'warranty_check',
      position: { x: 1120, y: -200 },
      data: { label: 'Warranty lookup', action: 'WARRANTY_CHECK' },
    },
    {
      id: 'n_w_active',
      type: 'message',
      position: { x: 1460, y: -260 },
      data: {
        label: 'Warranty active',
        text: 'Warranty is active for {{_warranty_product_name|your product}}.\nEnds: {{_warranty_expires_display|N/A}}\nOrder ref: {{_warranty_order_ref|-}}',
      },
    },
    {
      id: 'n_w_exp',
      type: 'message',
      position: { x: 1460, y: -160 },
      data: {
        label: 'Warranty expired',
        text: 'Warranty has expired for {{_warranty_product_name|this product}}.\nExpiry: {{_warranty_expires_display|N/A}}',
      },
    },
    {
      id: 'n_w_none',
      type: 'message',
      position: { x: 1460, y: -60 },
      data: {
        label: 'Warranty not found',
        text: 'No warranty on file for this number yet. Share your *order ID* on 9328613239 and we will help right away.',
      },
    },
    {
      id: 'n_install_lookup',
      type: 'shopify_call',
      position: { x: 1120, y: -40 },
      data: {
        label: 'Silent order lookup',
        action: 'CHECK_ORDER_STATUS',
        silent: true,
        variable: 'latest_order_ctx',
      },
    },
    {
      id: 'n_install_confirm',
      type: 'interactive',
      position: { x: 1460, y: -40 },
      data: {
        label: 'Install — confirm product',
        interactiveType: 'button',
        text: 'Latest order product: {{first_product_title|your last order}}.\nWant *install links* for this item?',
        buttonsList: [
          { id: 'ins_yes', title: 'Yes, this product' },
          { id: 'ins_no', title: 'Different product' },
          { id: 'ins_menu', title: 'Back to services' },
        ],
      },
    },
    {
      id: 'n_ins_y21',
      type: 'logic',
      position: { x: 1800, y: -120 },
      data: { label: 'Line has 2.1?', variable: 'metadata.first_product_title', operator: 'contains', value: '2.1' },
    },
    {
      id: 'n_ins_y20',
      type: 'logic',
      position: { x: 1800, y: -20 },
      data: { label: 'Else 2.0?', variable: 'metadata.first_product_title', operator: 'contains', value: '2.0' },
    },
    {
      id: 'n_ask_model',
      type: 'message',
      position: { x: 1800, y: 100 },
      data: {
        label: 'Ask product name',
        text: 'Type the *full product name* as on your bill (e.g. "Apex HDMI 2.1 TV Backlight").',
      },
    },
    {
      id: 'n_cap_model',
      type: 'capture_input',
      position: { x: 2120, y: 100 },
      data: {
        label: 'Capture product',
        question: 'Product name',
        text: 'Send the product name',
        variable: 'install_product_query',
      },
    },
    {
      id: 'n_cap_l21',
      type: 'logic',
      position: { x: 2440, y: 40 },
      data: { label: 'Typed 2.1?', variable: 'metadata.install_product_query', operator: 'contains', value: '2.1' },
    },
    {
      id: 'n_cap_l20',
      type: 'logic',
      position: { x: 2440, y: 140 },
      data: { label: 'Typed 2.0?', variable: 'metadata.install_product_query', operator: 'contains', value: '2.0' },
    },
    {
      id: 'n_cap_fallback',
      type: 'message',
      position: { x: 2760, y: 200 },
      data: {
        label: 'Manual handoff',
        text: 'We will confirm with you manually. Messaging *9328613239* speeds this up.',
        action: 'ESCALATE_HUMAN',
      },
    },
    {
      id: 'n_tr_menu',
      type: 'interactive',
      position: { x: 1120, y: 120 },
      data: {
        label: 'Troubleshoot — list',
        interactiveType: 'list',
        buttonText: 'Issues',
        text: 'Pick the symptom that fits best:',
        sections: [
          {
            title: 'Common fixes',
            rows: [
              { id: 't_sync', title: 'Not syncing to picture', description: '' },
              { id: 't_half', title: 'Half strip / partial glow', description: '' },
              { id: 't_wifi', title: 'Smart Life pairing', description: '' },
              { id: 't_color', title: 'Wrong colours / direction', description: '' },
              { id: 't_ps5', title: 'PS5 flicker / blackout', description: '' },
              { id: 't_hdmi', title: 'No device / cabling', description: '' },
              { id: 't_back', title: 'Back to services', description: '' },
            ],
          },
        ],
      },
    },
    {
      id: 'n_tt1',
      type: 'message',
      position: { x: 1460, y: 80 },
      data: { label: 'T/fix — no sync', text: COPY.tr_nosync },
    },
    {
      id: 'n_tt2',
      type: 'message',
      position: { x: 1460, y: 200 },
      data: { label: 'T/fix — half strip', text: COPY.tr_half },
    },
    {
      id: 'n_tt3',
      type: 'message',
      position: { x: 1460, y: 320 },
      data: { label: 'T/fix — app Wi‑Fi', text: COPY.tr_wifi },
    },
    {
      id: 'n_tt4',
      type: 'message',
      position: { x: 1460, y: 440 },
      data: { label: 'T/fix — colours', text: COPY.tr_colors },
    },
    {
      id: 'n_tt5',
      type: 'message',
      position: { x: 1460, y: 560 },
      data: { label: 'T/fix — PS5', text: COPY.tr_ps5 },
    },
    {
      id: 'n_tt6',
      type: 'message',
      position: { x: 1460, y: 680 },
      data: { label: 'T/fix — cabling', text: COPY.tr_cables },
    },
    {
      id: 'n_order',
      type: 'order_action',
      position: { x: 1120, y: 260 },
      data: { label: 'Order status', actionType: 'CHECK_ORDER_STATUS', action: 'CHECK_ORDER_STATUS' },
    },
    {
      id: 'n_human',
      type: 'message',
      position: { x: 1120, y: 380 },
      data: {
        label: 'Human handoff',
        text: 'Connecting you to the team — for fastest help send *photos or a short video* on *9328613239*.',
        action: 'ESCALATE_HUMAN',
      },
    },
    {
      id: 'n_footer',
      type: 'interactive',
      position: { x: 1900, y: 320 },
      data: {
        label: 'Anything else?',
        interactiveType: 'button',
        text: 'Was that helpful?',
        buttonsList: [
          { id: 'f_menu', title: 'Main services' },
          { id: 'f_start', title: 'Start over' },
          { id: 'f_human', title: 'Talk to human' },
        ],
      },
    },
  ];

  const edges = [
    { id: 'e_t0', source: 'n_trigger', target: 'n_entry' },
    { id: 'e_e1', source: 'n_entry', sourceHandle: 'ent_have', target: 'n_have_pick' },
    { id: 'e_e2', source: 'n_entry', sourceHandle: 'ent_buy', target: 'n_buy_intro' },
    { id: 'e_e3', source: 'n_entry', sourceHandle: 'ent_help', target: 'n_svc_menu' },
    { id: 'e_buy_cat', source: 'n_buy_intro', target: 'n_catalog' },

    { id: 'e_p1_more', source: 'n_have_pick', sourceHandle: 'p1_more', target: 'n_have_pick2' },
    { id: 'e_p2_more', source: 'n_have_pick2', sourceHandle: 'p2_more', target: 'n_have_pick3' },
    { id: 'e_p3_back', source: 'n_have_pick3', sourceHandle: 'p3_back', target: 'n_entry' },

    { id: 'e_p1_21', source: 'n_have_pick', sourceHandle: 'p1_hdmi21', target: 'n_hub21' },
    { id: 'e_p1_20', source: 'n_have_pick', sourceHandle: 'p1_hdmi20', target: 'n_hub20' },
    { id: 'e_p1_20b', source: 'n_have_pick', sourceHandle: 'p1_hdmi20b', target: 'n_hub20' },
    { id: 'e_p1_mon', source: 'n_have_pick', sourceHandle: 'p1_mon', target: 'n_other_line' },
    { id: 'e_p1_fl', source: 'n_have_pick', sourceHandle: 'p1_floor', target: 'n_other_line' },
    { id: 'e_p1_tb', source: 'n_have_pick', sourceHandle: 'p1_table', target: 'n_other_line' },
    { id: 'e_p1_ne', source: 'n_have_pick', sourceHandle: 'p1_neon', target: 'n_other_line' },
    { id: 'e_p1_up', source: 'n_have_pick', sourceHandle: 'p1_uplift', target: 'n_other_line' },
    { id: 'e_p1_st', source: 'n_have_pick', sourceHandle: 'p1_strip5', target: 'n_other_line' },

    { id: 'e_p2_all', source: 'n_have_pick2', sourceHandle: 'p2_cob', target: 'n_other_line' },
    { id: 'e_p2_px', source: 'n_have_pick2', sourceHandle: 'p2_pixel', target: 'n_other_line' },
    { id: 'e_p2_ed', source: 'n_have_pick2', sourceHandle: 'p2_edge', target: 'n_other_line' },
    { id: 'e_p2_fs', source: 'n_have_pick2', sourceHandle: 'p2_fls', target: 'n_other_line' },
    { id: 'e_p2_gm', source: 'n_have_pick2', sourceHandle: 'p2_game', target: 'n_other_line' },
    { id: 'e_p2_cr', source: 'n_have_pick2', sourceHandle: 'p2_curtain', target: 'n_other_line' },
    { id: 'e_p2_dn', source: 'n_have_pick2', sourceHandle: 'p2_deskneon', target: 'n_other_line' },
    { id: 'e_p2_st', source: 'n_have_pick2', sourceHandle: 'p2_star', target: 'n_other_line' },
    { id: 'e_p2_wl', source: 'n_have_pick2', sourceHandle: 'p2_wall', target: 'n_other_line' },

    { id: 'e_p3_out', source: 'n_have_pick3', sourceHandle: 'p3_out', target: 'n_other_line' },
    { id: 'e_p3_gtv', source: 'n_have_pick3', sourceHandle: 'p3_gtv', target: 'n_govee_line' },
    { id: 'e_p3_gb', source: 'n_have_pick3', sourceHandle: 'p3_gbar', target: 'n_govee_line' },
    { id: 'e_p3_dk', source: 'n_have_pick3', sourceHandle: 'p3_dock', target: 'n_govee_line' },

    { id: 'e_svc_cat', source: 'n_svc_menu', sourceHandle: 'svc_cat', target: 'n_catalog' },
    { id: 'e_svc_war', source: 'n_svc_menu', sourceHandle: 'svc_war', target: 'n_warranty' },
    { id: 'e_svc_in', source: 'n_svc_menu', sourceHandle: 'svc_inst', target: 'n_install_lookup' },
    { id: 'e_svc_fx', source: 'n_svc_menu', sourceHandle: 'svc_fix', target: 'n_tr_menu' },
    { id: 'e_svc_or', source: 'n_svc_menu', sourceHandle: 'svc_ord', target: 'n_order' },
    { id: 'e_svc_hm', source: 'n_svc_menu', sourceHandle: 'svc_human', target: 'n_human' },

    { id: 'e_w_a', source: 'n_warranty', sourceHandle: 'active', target: 'n_w_active' },
    { id: 'e_w_e', source: 'n_warranty', sourceHandle: 'expired', target: 'n_w_exp' },
    { id: 'e_w_n', source: 'n_warranty', sourceHandle: 'none', target: 'n_w_none' },

    { id: 'e_ins_def', source: 'n_install_lookup', target: 'n_install_confirm' },
    { id: 'e_ins_noord', source: 'n_install_lookup', sourceHandle: 'no_order', target: 'n_ask_model' },
    { id: 'e_ins_yes', source: 'n_install_confirm', sourceHandle: 'ins_yes', target: 'n_ins_y21' },
    { id: 'e_ins_no', source: 'n_install_confirm', sourceHandle: 'ins_no', target: 'n_ask_model' },
    { id: 'e_ins_menu', source: 'n_install_confirm', sourceHandle: 'ins_menu', target: 'n_svc_menu' },
    { id: 'e_ins21_t', source: 'n_ins_y21', sourceHandle: 'true', target: 'n_m21a' },
    { id: 'e_ins21_f', source: 'n_ins_y21', sourceHandle: 'false', target: 'n_ins_y20' },
    { id: 'e_ins20_t', source: 'n_ins_y20', sourceHandle: 'true', target: 'n_m20a' },
    { id: 'e_ins20_f', source: 'n_ins_y20', sourceHandle: 'false', target: 'n_ask_model' },
    { id: 'e_ask_cap', source: 'n_ask_model', target: 'n_cap_model' },
    { id: 'e_cap_l21', source: 'n_cap_model', target: 'n_cap_l21' },
    { id: 'e_c21_t', source: 'n_cap_l21', sourceHandle: 'true', target: 'n_m21a' },
    { id: 'e_c21_f', source: 'n_cap_l21', sourceHandle: 'false', target: 'n_cap_l20' },
    { id: 'e_c20_t', source: 'n_cap_l20', sourceHandle: 'true', target: 'n_m20a' },
    { id: 'e_c20_f', source: 'n_cap_l20', sourceHandle: 'false', target: 'n_cap_fallback' },
    { id: 'e_cap_fb', source: 'n_cap_fallback', target: 'n_footer' },

    { id: 'e_h21_v', source: 'n_hub21', sourceHandle: 'h21_vid', target: 'n_m21a' },
    { id: 'e_h21_s', source: 'n_hub21', sourceHandle: 'h21_strip', target: 'n_m21b' },
    { id: 'e_h21_h', source: 'n_hub21', sourceHandle: 'h21_hdmi', target: 'n_m21c' },
    { id: 'e_h21_w', source: 'n_hub21', sourceHandle: 'h21_wifi', target: 'n_m21d' },
    { id: 'e_h21_r', source: 'n_hub21', sourceHandle: 'h21_reset', target: 'n_m21e' },
    { id: 'e_h21_b', source: 'n_hub21', sourceHandle: 'h21_back', target: 'n_have_pick' },

    { id: 'e_h20_v', source: 'n_hub20', sourceHandle: 'h20_vid', target: 'n_m20a' },
    { id: 'e_h20_s', source: 'n_hub20', sourceHandle: 'h20_strip', target: 'n_m20b' },
    { id: 'e_h20_h', source: 'n_hub20', sourceHandle: 'h20_hdmi', target: 'n_m20c' },
    { id: 'e_h20_w', source: 'n_hub20', sourceHandle: 'h20_wifi', target: 'n_m20d' },
    { id: 'e_h20_r', source: 'n_hub20', sourceHandle: 'h20_reset', target: 'n_m20e' },
    { id: 'e_h20_b', source: 'n_hub20', sourceHandle: 'h20_back', target: 'n_have_pick' },

    { id: 'e_tr1', source: 'n_tr_menu', sourceHandle: 't_sync', target: 'n_tt1' },
    { id: 'e_tr2', source: 'n_tr_menu', sourceHandle: 't_half', target: 'n_tt2' },
    { id: 'e_tr3', source: 'n_tr_menu', sourceHandle: 't_wifi', target: 'n_tt3' },
    { id: 'e_tr4', source: 'n_tr_menu', sourceHandle: 't_color', target: 'n_tt4' },
    { id: 'e_tr5', source: 'n_tr_menu', sourceHandle: 't_ps5', target: 'n_tt5' },
    { id: 'e_tr6', source: 'n_tr_menu', sourceHandle: 't_hdmi', target: 'n_tt6' },
    { id: 'e_tr_b', source: 'n_tr_menu', sourceHandle: 't_back', target: 'n_svc_menu' },

    { id: 'e_ord_f', source: 'n_order', target: 'n_footer' },

    { id: 'e_f1', source: 'n_m21a', target: 'n_footer' },
    { id: 'e_f2', source: 'n_m21b', target: 'n_footer' },
    { id: 'e_f3', source: 'n_m21c', target: 'n_footer' },
    { id: 'e_f4', source: 'n_m21d', target: 'n_footer' },
    { id: 'e_f5', source: 'n_m21e', target: 'n_footer' },
    { id: 'e_f6', source: 'n_m20a', target: 'n_footer' },
    { id: 'e_f7', source: 'n_m20b', target: 'n_footer' },
    { id: 'e_f8', source: 'n_m20c', target: 'n_footer' },
    { id: 'e_f9', source: 'n_m20d', target: 'n_footer' },
    { id: 'e_f10', source: 'n_m20e', target: 'n_footer' },
    { id: 'e_f_w1', source: 'n_w_active', target: 'n_footer' },
    { id: 'e_f_w2', source: 'n_w_exp', target: 'n_footer' },
    { id: 'e_f_w3', source: 'n_w_none', target: 'n_footer' },
    { id: 'e_f_o', source: 'n_other_line', target: 'n_footer' },
    { id: 'e_f_g', source: 'n_govee_line', target: 'n_footer' },

    { id: 'e_f_tt1', source: 'n_tt1', target: 'n_footer' },
    { id: 'e_f_tt2', source: 'n_tt2', target: 'n_footer' },
    { id: 'e_f_tt3', source: 'n_tt3', target: 'n_footer' },
    { id: 'e_f_tt4', source: 'n_tt4', target: 'n_footer' },
    { id: 'e_f_tt5', source: 'n_tt5', target: 'n_footer' },
    { id: 'e_f_tt6', source: 'n_tt6', target: 'n_footer' },

    { id: 'e_ff_menu', source: 'n_footer', sourceHandle: 'f_menu', target: 'n_svc_menu' },
    { id: 'e_ff_start', source: 'n_footer', sourceHandle: 'f_start', target: 'n_entry' },
    { id: 'e_ff_human', source: 'n_footer', sourceHandle: 'f_human', target: 'n_human' },
  ];

  return { nodes, edges, FLOW_ID, FLOW_NAME, FLOW_DESCRIPTION };
}

module.exports = {
  buildFlow,
  FLOW_ID,
  FLOW_NAME,
  FLOW_DESCRIPTION,
};
