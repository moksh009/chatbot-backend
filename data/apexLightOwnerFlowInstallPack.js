"use strict";

/**
 * Apex Light — Installation hub (list picker, product guides, FAQ packs, support pre-screen).
 * Merged into apexLightOwnerFlow.js via spread.
 */

/** Product install cards — WA reply buttons max ~20 chars */
const BTN_GUIDE = [
  { id: "apex_talk_sup", title: "💬 Contact support" },
  { id: "apex_faq_list", title: "📚 FAQs" },
  { id: "apex_back_menu", title: "🏠 Main menu" },
];

/** FAQ answer screens */
const BTN_FAQ_ANS = [
  { id: "apex_faq_list", title: "📚 FAQ list" },
  { id: "apex_talk_sup", title: "🙋 Talk to team" },
  { id: "apex_back_menu", title: "🏠 Main menu" },
];

/** After “other product” capture */
const BTN_OTHER = [
  { id: "apex_back_menu", title: "🏠 Main menu" },
  { id: "apex_talk_sup", title: "🙋 Talk to team" },
  { id: "apex_faq_list", title: "📚 FAQs" },
];

const T = {
  hdmi21: `*APEX HDMI 2.1 TV BACKLIGHT (UPTO 90 INCH)*

Here's the complete Installation Guide for this product

📽️ *Video*
https://youtu.be/b82bLHryIxM?feature=shared

Must download *SmartLife* App.
*Android:* https://play.google.com/store/apps/details?id=com.tuya.smartlife
*iOS:* https://apps.apple.com/in/app/smartlife-smart-living/id1115101477`,
  hdmi20: `*APEX HDMI 2.0 TV BACKLIGHT (UPTO 90 INCH) & APEX HDMI 2.0 TV BACKLIGHT + BAR LIGHT(UPTO 90 INCH)*

Here's the complete Installation Guide for this product

📽️ *Video*
https://youtu.be/iPyzkp_guTA?feature=shared

Must download *SmartLife* App.
*Android:* https://play.google.com/store/apps/details?id=com.tuya.smartlife
*iOS:* https://apps.apple.com/in/app/smartlife-smart-living/id1115101477`,
  otherCap: `📋 *Other product — we’re here to help*

We don’t have a *dedicated install guide* for this item yet.

✍️ Tell us *exactly* what’s going wrong (or what you need) in *one message* below — our team reads every note.`,
  faq1Intro: `❓ *Quick answers — FAQ pack 1*

Tap a question below — most fixes take under a minute ⏱️`,
  faq2Intro: `✨ *Still browsing? — FAQ pack 2*

More common topics below — you’ve got this 💪`,
  supportPre: `🛟 *Before we loop in a human…*

Most HDMI / strip / app questions are already answered in our FAQs — worth a 10-second peek 👀

✅ *Try this first*
• Tap *📚 FAQs* — instant answers for sync, Wi‑Fi, cutting, HDMI, PS5 flicker, and more

🙋 *Need a person?*
• Tap *🙋 Talk to team* — we’ll *notify the crew* and pause the bot so a human can reply

💡 *Pro tip:* add a *photo or short video* after — we solve things faster 📸`,
};

const FAQ1 = [
  { id: "faq_r1", title: "❌ Only 1 LED strip?", desc: "Both strips required — cut at dots", ans: `*Question:* The product comes with 2 LED strips. Is it okay if I install only one?

👉 You have to install *both* LED strips. You can start sticking them from the left bottom or the right bottom. You need to cut both LED strips according to your TV size. You can cut the LED strips only at the *white dotted lines* between the three copper dots.

*(Reference images: TV from back — how strips look; how to stick at corners — see your printed guide or message us on 9328613239 for photos.)*` },
  { id: "faq_r2", title: "🔄 Colors reversed?", desc: "Swap USB + app direction", ans: `*Question:* The colors are coming in the opposite direction on the LED strip?

👉 Try interchanging the *USB cables* of the LED strips in the sync box. If the problem still persists, open the *Smart Life* app → setup → change *direction* (left↔right).` },
  { id: "faq_r3", title: "💡 Half strip glow?", desc: "Restart after cutting", ans: `*Question:* Only half of the LED strip is glowing?

👉 Try *restarting the sync box* after cutting the LED strip according to your TV size. There is a button behind the sync box — press and hold ~10 seconds; the LED will blink and the product will restart.` },
  { id: "faq_r4", title: "🔁 Full restart?", desc: "Order of cables matters", ans: `*Question:* Are there any steps to restart the product?

👉 *Press and hold* the button behind the sync box for ~10 seconds.
Turn off the switch → remove all connections → first connect *both USB cables* of the strips → connect device to *HDMI IN* → *HDMI OUT* to TV → connect adapter → turn on.

Please follow *every step in sequence*.` },
  { id: "faq_r5", title: "✂️ Must cut strip?", desc: "Yes — sync needs real size", ans: `*Question:* Is it necessary to cut the LED strip according to my TV size?

👉 *Yes* — it is compulsory. Once you cut, the sync box recognises your TV size. If you don't cut, it assumes *90 inches* and syncs incorrectly.` },
  { id: "faq_r6", title: "📍 Where to cut?", desc: "White dotted lines only", ans: `*Question:* Where should I cut the LED strip?

👉 You can see *white dotted lines* between three yellow/copper dots on the strip — cut *only* from there.` },
  { id: "faq_r7", title: "♻️ Leftover strip?", desc: "Keep it — can extend later", ans: `*Question:* If I cut the LED strip, will the leftover go to waste?

👉 *No* — keep the extra strip. You can solder it later to make it full size for a bigger TV.` },
  { id: "faq_r8", title: "🔌 One HDMI only?", desc: "OUT→TV, device→IN", ans: `*Question:* I received only one HDMI cable in the box.

👉 *Yes* — we provide one HDMI cable: use it from *HDMI OUT* on the sync box → TV. Your existing cable from your device (PlayStation etc.) goes to *HDMI IN* on the sync box instead of directly to the TV.` },
  { id: "faq_r9", title: "📶 SmartLife Wi‑Fi?", desc: "2.4 GHz + same network", ans: `*Question:* I can't connect the product to the SmartLife app.

👉 Connect using *2.4 GHz* Wi-Fi. The same network must be selected on your phone *and* in the app. If your router has no 2.4 GHz option, use another phone's *hotspot* for first-time setup only.` },
];

const FAQ2 = [
  { id: "faq_r11", title: "📺 Video not syncing?", desc: "Need HDMI source through box", ans: `*Question:* I'm playing video, but it's not syncing.

👉 This is an *HDMI TV backlight*. Connect an external device (PlayStation, Apple TV, Fire Stick, set-top box) to *HDMI IN* on the sync box, and *HDMI OUT* from the sync box to the TV. Example: play from PlayStation through the sync path — lights sync.

*Note:* HDMI TV backlights in the market *do not sync* with built-in smart TV apps.` },
  { id: "faq_r12", title: "🔀 Two on HDMI IN?", desc: "One device only", ans: `*Question:* Can I connect two devices to the HDMI input port?

👉 *No* — only one device at a time. Use an *HDMI splitter/switch* if you need multiple sources.` },
  { id: "faq_r13", title: "📐 Where to start strip?", desc: "Bottom-left, clockwise", ans: `*Question:* Where should I start sticking the LED strip?

👉 Start *compulsorily from bottom-left* (facing TV from the back) and follow *clockwise*. *(Reference: corner stick diagram — ask on 9328613239 for image pack.)*` },
  { id: "faq_r14", title: "↪️ Start from right?", desc: "Must start bottom-left", ans: `*Question:* Can I start from the right downside instead of left (facing TV from back)?

👉 *No* — you must start from *bottom-left*. The product is designed to work only this way.` },
  { id: "faq_r15", title: "🔁 2 devices HDMI IN?", desc: "Same as above — one port", ans: `*Question:* Can I connect 2 devices to HDMI IN?

👉 *No* — one device at a time. Use an HDMI splitter if needed.` },
  { id: "faq_r16", title: "💡 Half glow after cut?", desc: "8-step power sequence", ans: `*Question:* Only half the LED strip glows after cutting to TV size.

👉 Try once:
1) Restart sync box — hold green button ~10s
2) Turn off power
3) Remove all connections
4) Connect *HDMI IN* first
5) *HDMI OUT*
6) Strip USB in belt port
7) Adapter last
8) Power on

Follow *every step in sequence*.` },
  { id: "faq_r17", title: "❓ No device found?", desc: "Restart + swap HDMI", ans: `*Question:* When I connect my device it shows *no device found*.

👉 Full restart (same 8-step order as FAQ 16). If it persists, try another *TV HDMI port* for OUT. Then try swapping HDMI cables one at a time (IN first, then OUT).` },
  { id: "faq_r18", title: "🎮 PS flicker / black?", desc: "VRR HDR + 4:2:0", ans: `*Question:* Screen flickers; PlayStation on but screen goes off sometimes.

👉 Turn off *VRR* and *HDR* in PlayStation settings. If it still persists, set refresh rate to *4:2:0*.` },
];

function faqAnswerNodes(prefix, rows) {
  return rows.map((row, i) => ({
    id: `${prefix}_${row.id}`,
    type: "interactive",
    position: { x: 1780, y: -400 + i * 120 },
    data: {
      label: `FAQ ${row.id}`,
      interactiveType: "button",
      text: row.ans,
      buttonsList: BTN_FAQ_ANS,
      heatmapCount: 0,
    },
  }));
}

const nodes = [
  {
    id: "n_install_menu",
    type: "interactive",
    position: { x: 1120, y: -120 },
    data: {
      label: "Install — product list",
      interactiveType: "list",
      header: "✨ Apex Light",
      buttonText: "📋 Choose product",
      text: "📦 *Installation guides*\n\nPick your product below — each option opens the *video + SmartLife* steps we recommend ✨",
      sections: [
        {
          title: "📺 Your model",
          rows: [
            { id: "inst_hdmi21", title: "🔆 HDMI 2.1 ≤90\"", description: "TV backlight — full install + video link" },
            { id: "inst_hdmi20", title: "🔆 HDMI 2.0 + bar", description: "2.0 strip & 2.0+bar combo — one guide" },
            { id: "inst_other", title: "📋 Other product", description: "No guide yet — tell us what you need" },
            { id: "inst_faq", title: "❓ FAQ list", description: "Top questions from the team" },
            { id: "inst_back", title: "🏠 Back to menu", description: "Return to main hub" },
          ],
        },
      ],
      heatmapCount: 0,
    },
  },
  {
    id: "n_inst_hdmi21_card",
    type: "interactive",
    position: { x: 1460, y: -200 },
    data: {
      label: "Install guide HDMI 2.1",
      interactiveType: "button",
      text: T.hdmi21,
      buttonsList: BTN_GUIDE,
      heatmapCount: 0,
    },
  },
  {
    id: "n_inst_hdmi20_card",
    type: "interactive",
    position: { x: 1460, y: -40 },
    data: {
      label: "Install guide HDMI 2.0",
      interactiveType: "button",
      text: T.hdmi20,
      buttonsList: BTN_GUIDE,
      heatmapCount: 0,
    },
  },
  {
    id: "n_inst_other_capture",
    type: "capture_input",
    position: { x: 1460, y: 120 },
    data: {
      label: "Other product — capture",
      text: T.otherCap,
      question: "Describe your issue",
      variable: "install_other_issue",
      validationType: "any",
      heatmapCount: 0,
    },
  },
  {
    id: "n_inst_other_after",
    type: "interactive",
    position: { x: 1780, y: 120 },
    data: {
      label: "Other — thanks + actions",
      interactiveType: "button",
      text: "Thanks ✨ — we’ve got your note. Need anything else? Tap below 👇",
      buttonsList: BTN_OTHER,
      heatmapCount: 0,
    },
  },
  {
    id: "n_support_pre",
    type: "interactive",
    position: { x: 1120, y: 380 },
    data: {
      label: "Support — FAQ first gate",
      interactiveType: "button",
      text: T.supportPre,
      buttonsList: [
        { id: "sup_pre_faq", title: "📚 FAQs" },
        { id: "sup_pre_talk", title: "🙋 Talk to team" },
      ],
      heatmapCount: 0,
    },
  },
  {
    id: "n_faq_list_1",
    type: "interactive",
    position: { x: 1460, y: 280 },
    data: {
      label: "FAQ pack 1",
      interactiveType: "list",
      header: "❓ FAQs",
      buttonText: "📋 Questions",
      text: T.faq1Intro,
      sections: [
        {
          title: "⭐ Top picks",
          rows: FAQ1.map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: (r.desc || "").slice(0, 72) })).concat([
            { id: "faq_r10_more", title: "➕ More FAQs", description: "Page 2 — sync, HDMI, PS5…" },
          ]),
        },
      ],
      heatmapCount: 0,
    },
  },
  {
    id: "n_faq_list_2",
    type: "interactive",
    position: { x: 1460, y: 520 },
    data: {
      label: "FAQ pack 2",
      interactiveType: "list",
      header: "✨ FAQs+",
      buttonText: "📋 More",
      text: T.faq2Intro,
      sections: [
        {
          title: "🛠 Deeper fixes",
          rows: FAQ2.map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: (r.desc || "").slice(0, 72) })).concat([
            { id: "faq_r19_support", title: "🙋 Talk to team", description: "Human handoff" },
            { id: "faq_r20_menu", title: "🏠 Main menu", description: "Back to hub" },
          ]),
        },
      ],
      heatmapCount: 0,
    },
  },
  ...faqAnswerNodes("n_faq_a", FAQ1),
  ...faqAnswerNodes("n_faq_b", FAQ2),
];

const edges = [
  { id: "e_btn_install", source: "n_main_menu", sourceHandle: "btn_install", target: "n_install_menu" },
  { id: "e_tv_inst", source: "n_tv_cta", sourceHandle: "tv_install", target: "n_install_menu" },
  { id: "e_btn_support", source: "n_main_menu", sourceHandle: "btn_support", target: "n_support_pre" },
  { id: "e_tv_sup", source: "n_tv_cta", sourceHandle: "tv_support", target: "n_support_pre" },
  { id: "e_ff_support", source: "n_footer", sourceHandle: "f_support", target: "n_support_pre" },
  { id: "e_pi_mon", source: "n_monitor_cta", sourceHandle: "mon_pi", target: "n_install_menu" },
  { id: "e_pi_gov", source: "n_govee_cta", sourceHandle: "gov_pi", target: "n_install_menu" },
  { id: "e_pi_fl", source: "n_floor_cta", sourceHandle: "fl_pi", target: "n_install_menu" },
  { id: "e_pi_gm", source: "n_gaming_cta", sourceHandle: "gm_pi", target: "n_install_menu" },
  { id: "e_pi_st", source: "n_strip_cta", sourceHandle: "st_pi", target: "n_install_menu" },
  { id: "e_ps_mon", source: "n_monitor_cta", sourceHandle: "mon_ps", target: "n_support_pre" },
  { id: "e_ps_gov", source: "n_govee_cta", sourceHandle: "gov_ps", target: "n_support_pre" },
  { id: "e_ps_fl", source: "n_floor_cta", sourceHandle: "fl_ps", target: "n_support_pre" },
  { id: "e_ps_gm", source: "n_gaming_cta", sourceHandle: "gm_ps", target: "n_support_pre" },
  { id: "e_ps_st", source: "n_strip_cta", sourceHandle: "st_ps", target: "n_support_pre" },
  { id: "e_other_sup", source: "n_other_products", sourceHandle: "other_support", target: "n_support_pre" },
  { id: "e_inst_hdmi21", source: "n_install_menu", sourceHandle: "inst_hdmi21", target: "n_inst_hdmi21_card" },
  { id: "e_inst_hdmi20", source: "n_install_menu", sourceHandle: "inst_hdmi20", target: "n_inst_hdmi20_card" },
  { id: "e_inst_other", source: "n_install_menu", sourceHandle: "inst_other", target: "n_inst_other_capture" },
  { id: "e_inst_faq", source: "n_install_menu", sourceHandle: "inst_faq", target: "n_faq_list_1" },
  { id: "e_inst_back", source: "n_install_menu", sourceHandle: "inst_back", target: "n_main_menu" },
  { id: "e_other_cap_after", source: "n_inst_other_capture", target: "n_inst_other_after" },
  { id: "e_sup_pre_faq", source: "n_support_pre", sourceHandle: "sup_pre_faq", target: "n_faq_list_1" },
  { id: "e_sup_pre_talk", source: "n_support_pre", sourceHandle: "sup_pre_talk", target: "n_admin_alert" },
  { id: "e_faq_more", source: "n_faq_list_1", sourceHandle: "faq_r10_more", target: "n_faq_list_2" },
];

for (const row of FAQ1) {
  edges.push({
    id: `e_f1_${row.id}`,
    source: "n_faq_list_1",
    sourceHandle: row.id,
    target: `n_faq_a_${row.id}`,
  });
  edges.push(
    { id: `e_fa_${row.id}_faq`, source: `n_faq_a_${row.id}`, sourceHandle: "apex_faq_list", target: "n_faq_list_1" },
    { id: `e_fa_${row.id}_sup`, source: `n_faq_a_${row.id}`, sourceHandle: "apex_talk_sup", target: "n_support_pre" },
    { id: `e_fa_${row.id}_mm`, source: `n_faq_a_${row.id}`, sourceHandle: "apex_back_menu", target: "n_main_menu" }
  );
}

for (const row of FAQ2) {
  edges.push({
    id: `e_f2_${row.id}`,
    source: "n_faq_list_2",
    sourceHandle: row.id,
    target: `n_faq_b_${row.id}`,
  });
  edges.push(
    { id: `e_fb_${row.id}_faq`, source: `n_faq_b_${row.id}`, sourceHandle: "apex_faq_list", target: "n_faq_list_1" },
    { id: `e_fb_${row.id}_sup`, source: `n_faq_b_${row.id}`, sourceHandle: "apex_talk_sup", target: "n_support_pre" },
    { id: `e_fb_${row.id}_mm`, source: `n_faq_b_${row.id}`, sourceHandle: "apex_back_menu", target: "n_main_menu" }
  );
}

edges.push(
  { id: "e_f2_19", source: "n_faq_list_2", sourceHandle: "faq_r19_support", target: "n_support_pre" },
  { id: "e_f2_20", source: "n_faq_list_2", sourceHandle: "faq_r20_menu", target: "n_main_menu" }
);

for (const id of ["n_inst_hdmi21_card", "n_inst_hdmi20_card", "n_inst_other_after"]) {
  edges.push(
    { id: `e_${id}_faq`, source: id, sourceHandle: "apex_faq_list", target: "n_faq_list_1" },
    { id: `e_${id}_sup`, source: id, sourceHandle: "apex_talk_sup", target: "n_support_pre" },
    { id: `e_${id}_mm`, source: id, sourceHandle: "apex_back_menu", target: "n_main_menu" }
  );
}

module.exports = { nodes, edges };
