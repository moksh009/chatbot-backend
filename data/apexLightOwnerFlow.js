/**
 * Apex Light — complete WhatsApp support & commerce (TopEdge Flow Builder).
 * Primary hub: 3 reply buttons (WA max 3). Full service list: n_service_menu (keywords: track, order, warranty, troubleshoot, model, shop… OR troubleshoot → Back to hub).
 * Each explore category: Meta product_list when catalog id is set (apexDualMethod), else text fallback via no_catalog edge.
 */

const FLOW_ID = "flow_apex_owner_support_hub_v2";
const FLOW_NAME = "Apex Light — WhatsApp support & commerce";
const FLOW_DESCRIPTION = "Keyword + first_message welcome (3-button hub), dual Meta catalog + text fallback per category, install list + FAQ packs, silent order lookup for order/warranty paths, HDMI 2.1/2.0 deep-dive hubs, service list (track/warranty/fix/models/shop), support FAQ gate then admin alert + live handoff, footer loopbacks.";

const apexLightOwnerFlowInstallPack = require("./apexLightOwnerFlowInstallPack");

const LOGO = "https://apexlight.in/cdn/shop/files/07708086-ccae-4d21-93e2-fe0ed52b33a2.jpg?v=1714210021";
const HDMI21_WIRING = "https://apexlight.in/cdn/shop/files/hdmi21_wiring_diagram.jpg";
const HDMI21_CUT = "https://apexlight.in/cdn/shop/files/hdmi21_cut_points.jpg";
const HDMI20_WIRING = "https://apexlight.in/cdn/shop/files/hdmi20_wiring_diagram.jpg";

const COPY = {
  "mainMenuText": "Hi! How can we help you today?\n\n🛍️ Explore our products with prices\n📦 Get your product installed (quick guide)\n🎧 Talk to our support team",
  "serviceMenuText": "*More services*\n\nTrack an order, check warranty, troubleshoot, browse the shop, or pick your model. You can also return to the three main choices.",
  "tvIntro": "📺 *TV Backlights — Our Range*\n\nAll models support HDMI sync up to 90\" TV. Tap the product links below to visit the product page and order directly.",
  "tvProducts": "🔆 *Apex HDMI 2.1 TV Backlight* (32-90 inch)\nPrice: Rs. 9,999\n🛒 https://apexlight.in/products/apex-hdmi-2-1-version-tv-backlight\n\n🔆 *Apex HDMI 2.0 TV Backlight* (up to 90 inch)\nPrice: Rs. 7,599\n🛒 https://apexlight.in/products/apex-hdmi-sync-tv-backlight-for-all-tv-sizes-upto-90-inches\n\n🔆 *Apex HDMI 2.0 + Bar Light* (up to 90 inch)\nPrice: Rs. 10,499\n🛒 https://apexlight.in/products/apex-hdmi-sync-tv-backlight-hdmi-sync-bar-light\n\n🔆 *Govee TV Backlight 3 Lite*\nPrice: Rs. 8,499\n🛒 https://apexlight.in/products/govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything",
  "tvCta": "Need help choosing? Our team is happy to suggest the right model for your TV size and setup.",
  "monitorIntro": "📺 *Monitor Sync Lighting*\n\nBring your PC or gaming setup to life with monitor-synced colours.",
  "monitorProducts": "• *Monitor Backlight* (up to 40\") - Rs. 2,299\n  https://apexlight.in/products/apex-monitor-backlight-upto-40-inches-monitor-size-color-changing-with-screen-sync-box-pc-backlight-rgb5050-smart-led-strip-with-1-year-warranty\n\n• *Monitor Sync Bar Light* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-bar-light\n\n• *Monitor Sync Floor Lamp* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-floor-lamp\n\n• *Triangle Light (6 Pcs)* - Rs. 4,499\n  https://apexlight.in/products/apex-monitor-sync-triangle-light\n\n• *Hexagon Light (6 Pcs)* - Rs. 4,499\n  https://apexlight.in/products/apex-monitor-sync-hexagon-light",
  "goveeIntro": "✨ *Govee Smart Lighting — Apex Authorized*\n\nBrowse curated picks and prices below.",
  "goveeProducts": "• *Govee TV Backlight 3 Lite* - Rs. 8,499\n  https://apexlight.in/products/govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything\n\n• *Govee RGBIC TV Light Bars* - ~~Rs. 6,999~~ Rs. 5,499 🔥\n  https://apexlight.in/products/govee-rgbic-tv-light-bars\n\n• *Govee RGBICW Smart Floor Lamp* - ~~Rs. 7,999~~ Rs. 6,399\n  https://apexlight.in/products/govee-rgbicw-smart-floor-lamp-basic\n\n• *Govee RGBICW LED Strip Lights* - From Rs. 4,999\n  https://apexlight.in/products/govee-rgbicw-led-strip-lights",
  "floorIntro": "🌟 *Floor Lamps & Table Lamps*\n\nBrowse our range below.",
  "floorProducts": "• *Monitor Sync Floor Lamp* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-floor-lamp\n\n• *RGBICW Floor Lamp* - Rs. 4,999\n  https://apexlight.in/products/apex-rgbic-floor-lamp\n\n• *Uplighter Floor Lamp* - ~~Rs. 16,999~~ Rs. 11,999 🔥\n  https://apexlight.in/products/apex-uplighter-floor-lamp\n\n• *RGBICW Floor Lamp with Speaker* - Rs. 9,499\n  https://apexlight.in/products/apex-rgbicw-floor-lamp-with-speaker\n\n• *RGBCW Smart Table Lamp* - Rs. 1,699\n  https://apexlight.in/products/apex-rgbcw-smart-table-lamp",
  "gamingIntro": "🎮 *Gaming & Setup Lighting*\n\nLevel up your desk and TV zone.",
  "gamingProducts": "• *HDMI 2.1 TV Backlight* (32-90\") - Rs. 9,999\n  https://apexlight.in/products/apex-hdmi-2-1-version-tv-backlight\n\n• *Smart RGBIC Gaming Light Bars* - Rs. 5,299\n  https://apexlight.in/products/apex-smart-rgbic-gaming-light-bars\n\n• *Monitor Sync Bar Light* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-bar-light\n\n• *Triangle Light (RGBIC)* - Rs. 7,999\n  https://apexlight.in/products/apex-triangle-light\n\n• *Hexagon Light (RGBIC Big)* - Rs. 7,999\n  https://apexlight.in/products/apex-hexagon-light-6-pack-6\n\n• *Hexagon Panels (Small, 10 Pcs)* - Rs. 5,499\n  https://apexlight.in/products/apex-hexagon-light-panels-small-10-piece\n\n• *Smart Wall Light Line (6 line)* - Rs. 4,999\n  https://apexlight.in/products/apex-smart-wall-light-line6-line\n\n• *Smart Wall Light Line (9 line)* - Rs. 6,999\n  https://apexlight.in/products/apex-smart-wall-light-line9-line",
  "stripIntro": "💡 *LED Strip Lights*\n\nFlexible RGB, neon, and COB options.",
  "stripProducts": "• *RGBIC COB Strip Light (5M)* - Rs. 3,999\n  https://apexlight.in/products/apex-rgbic-cob-led-strip-light\n\n• *Edge Neon Light (3M)* - Rs. 4,999\n  https://apexlight.in/products/apex-edge-none-light\n\n• *Neon Rope Light (RGBIC)* - Rs. 2,999\n  https://apexlight.in/products/apex-neon-rope-light-rgbic\n\n• *Neon Rope for Desks (3M)* - Rs. 5,499\n  https://apexlight.in/products/apex-rgbic-led-neon-rope-lights-for-desks\n\n• *RGB-IC LED Strip (5M)* - Rs. 3,499\n  https://apexlight.in/products/apex-rgb-ic-led-strip-light-5m-16-4ft",
  "prodCta": "Would you like help with a product, or want to talk to our team?",
  "buyIntro": "Thanks for choosing *Apex Light*!\n\nIf you want to *purchase* or have *questions before you buy*, message or call us on *9328613239* — we reply fastest there.\n\nRight after this message you can also *open our WhatsApp catalogue* to see products with images and add to cart (enable Meta Catalog under Settings → Commerce if needed).",
  "installIntro": "📦 *Installation Help*\n\nWe'll pull up the right guide for your product right away. Checking your last order...",
  "installNoOrder": "🔍 *No order found on this number*\n\nThat's okay — this can happen if:\n• The order was placed with a different phone number\n• Your team is still importing offline sales\n\n*What to do:*\nReply with your *order ID* (e.g. #1042) or the *exact product name* from your bill.\n\nExamples:\n• Apex HDMI 2.1 TV Backlight\n• Apex HDMI 2.0 TV Backlight",
  "typedFallback": "Thanks! Our team will check your product and send the right guide.\n\n📞 For fastest help, send a *photo of your product label* on *9328613239* and we'll confirm the exact model within minutes.",
  "m21_install_caption": "*Apex HDMI 2.1 TV Backlight* — Installation Guide\n\n*Installation video:* https://youtu.be/b82bLHryIxM?feature=shared\n\n*App to download:* Smart Life (SmartLife)\nAndroid: https://play.google.com/store/apps/details?id=com.tuya.smartlife\niOS: https://apps.apple.com/in/app/smartlife-smart-living/id1115101477\n\n📌 *The box has 2 LED strips — install both.*\nYou can start from bottom-left or bottom-right (facing TV from the back).\n\n✂️ *Cutting:* Cut only on white dotted lines between the 3 copper dots. Both strips must be cut to your TV size.\n\n🔄 *Wrong direction?* Swap the USB cables of the two strips in the sync box. Or open Smart Life → Setup → Change direction.",
  "m21_strip_caption": "*LED Strip & Cutting — HDMI 2.1*\n\n✅ *You MUST cut the strip to your TV size.* The sync box learns your TV size from the cut length.\n\n✂️ Cut only on the *white dotted lines* between the 3 copper dots.\n\n💡 *Leftover strip?* Keep it — you can solder it later for a larger TV.\n\n*Half strip only glowing?* Do the full restart sequence:\n1️⃣ Hold sync box button ~10s (LEDs blink)\n2️⃣ Turn off power\n3️⃣ Remove all connections\n4️⃣ Connect both strip USB cables first\n5️⃣ HDMI source → HDMI IN on sync box\n6️⃣ HDMI OUT → TV\n7️⃣ Adapter last, then power on\n\n⚠️ *Order matters. Follow every step in sequence.*\n\n*One HDMI cable in box?* That cable goes HDMI OUT → TV. Your device's existing cable goes to HDMI IN on the sync box.",
  "m21_hdmi": "*HDMI Syncing Guide — 2.1*\n\n*Not syncing?*\nConnect an external device (PlayStation, Apple TV, Fire Stick, set-top box) to sync box *HDMI IN*, and sync box *HDMI OUT* to the TV.\n\n⚠️ *IMPORTANT:* HDMI TV backlights *do not sync with built-in smart TV apps* — you need an external HDMI source through the sync box.\n\n*Two devices on one HDMI IN?*\nNo — only one device at a time. Use an *HDMI switch/splitter* if needed.\n\n*\"No device found\" error?*\nTry the full restart sequence (HDMI IN first, then OUT, then USB, then adapter).\nTry another TV HDMI port for the OUT cable.\nSwap HDMI cables one at a time if you have spares.",
  "m21_wifi": "*Smart Life / Wi-Fi Setup — 2.1*\n\n📶 Use *2.4 GHz* Wi-Fi only.\nThe phone's Wi-Fi and the Smart Life app must be on the *same network*.\n\n*Router doesn't show 2.4 GHz separately?*\nUse another phone as a hotspot. Connect both your phone Wi-Fi AND the app to that hotspot. This setup is only needed the first time.",
  "m21_restart": "*Full Restart Sequence — HDMI 2.1*\n\nFollow every step *in this exact order:*\n\n1️⃣ Hold button behind sync box ~10 seconds (LEDs blink)\n2️⃣ Turn off power\n3️⃣ Unplug everything\n4️⃣ Connect both strip USB cables\n5️⃣ Connect HDMI IN from your source device\n6️⃣ Connect HDMI OUT to TV\n7️⃣ Connect adapter and turn on\n\nStill not working?\n• Try a different TV HDMI port for the OUT cable\n• Swap HDMI cables one at a time (start with HDMI IN, then HDMI OUT)",
  "m21_ps5": "*PlayStation Screen Flicker Fix*\n\nIf your screen goes black or flickers when using PS4/PS5 with the sync box:\n\n1️⃣ Go to PS4/PS5 *Settings → Screen and Video → Video Output*\n2️⃣ Turn off *VRR* (Variable Refresh Rate)\n3️⃣ Turn off *HDR*\n4️⃣ If still flickering: change *HDMI Format* to *4:2:0*\n\nThis resolves 95% of PlayStation compatibility issues.",
  "m20_install_caption": "*Apex HDMI 2.0 TV Backlight* — Installation Guide\n\n*Installation video:* https://youtu.be/iPyzkp_guTA?feature=shared\n\n*App to download:* Smart Life (SmartLife)\nAndroid: https://play.google.com/store/apps/details?id=com.tuya.smartlife\niOS: https://apps.apple.com/in/app/smartlife-smart-living/id1115101477\n\n📌 *Where to start:* Always start from the *bottom-left* (facing the TV from the back) and go *clockwise*. This product is designed to work ONLY this way.\n\n*Bought the kit without the bar?* Your setup has no bar lights — everything else in the video still applies.",
  "m20_strip": "*Strip & Cutting — HDMI 2.0*\n\n✂️ *Cutting is required* for correct sync.\n\nIf you don't cut: the sync box assumes a 90\" TV and syncs incorrectly.\n\nCut only on the *white dotted lines* between the 3 yellow/copper dots.\n\n*Leftover strip?* Keep it for future use (you can solder it for a larger TV).\n\n*Half strip glowing after cutting?*\n1️⃣ Hold green button on sync box ~10 seconds\n2️⃣ Turn off power\n3️⃣ Remove all connections\n4️⃣ Connect HDMI IN first\n5️⃣ Connect HDMI OUT\n6️⃣ Connect strip USB cable in the belt port\n7️⃣ Connect adapter last\n8️⃣ Turn on power\n\n⚠️ Follow every step in sequence — order matters.\n\n*\"No device\" error?* Same restart sequence, then try alternate TV HDMI ports, then try swapping HDMI cables one by one.",
  "m20_hdmi": "*Syncing Rules — HDMI 2.0*\n\nSame as the 2.1 family:\n\nUse an *external HDMI source* through the sync box.\nDevice → HDMI IN on sync box → HDMI OUT → TV\n\nBuilt-in smart TV apps (Netflix, YouTube) *will not drive colour sync.*\n\n*Multiple devices?* Use an HDMI switch/splitter — sync box has only one HDMI IN port.",
  "m20_wifi": "*Smart Life / Wi-Fi — HDMI 2.0*\n\n📶 Use *2.4 GHz* Wi-Fi only.\nThe phone and app must be on the same network.\n\n*Router hiding 2.4 GHz?* Use a mobile hotspot — connect both the phone Wi-Fi and the app to it. Only needed for first-time setup.",
  "m20_restart": "*Restart Sequence — HDMI 2.0*\n\n1️⃣ Hold green button ~10 seconds (product restarts)\n2️⃣ Remove power\n3️⃣ Unplug all connections\n4️⃣ Connect HDMI IN\n5️⃣ Connect HDMI OUT\n6️⃣ Connect strip USB cable in belt port\n7️⃣ Connect adapter and power on\n\n⚠️ Follow in sequence.\n\n*PlayStation flickering / screen going black?*\n→ Disable *VRR* and *HDR* in PS settings\n→ Set HDMI format to *4:2:0*",
  "otherProducts": "For Monitor Sync, floor lamps, neon lights, Govee co-branded products, and the Stream Dock — our team provides model-specific guides.\n\n📸 Send us a *photo of your product label* so we can route you to the exact instructions.\n\nOr call us directly on *9328613239*.",
  "govee_misc": "For *Govee TV Backlight 3 Lite*, *Govee RGBIC TV Light Bars*, and *Apex Stream Dock*, tell us the *exact model/size* on *9328613239* so we can route you to the right guide.",
  "tr_nosync": "*Not syncing*\n\n1) Confirm *external HDMI source* flows: device → sync box HDMI *IN*, sync box HDMI *OUT* → TV.\n2) Remember: *no sync* from TV's *built-in* Netflix/YouTube apps — use Fire Stick, console, Apple TV, etc.\n3) Retry the full cable order from the FAQ (especially HDMI IN before OUT).\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "tr_half": "*Half strip / only part glowing*\n\nAfter cutting to size, do a full power cycle and reconnect in *sequence*: HDMI IN → HDMI OUT → strip USB → power last.\n\nFor 2.0 follow the green-button reset steps from the FAQ pack.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "tr_wifi": "*App won't connect*\n\nUse *2.4 GHz Wi-Fi* only; phone and Smart Life must be on that same network. Try a mobile hotspot once if your mesh router blocks 2.4 GHz.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "tr_colors": "*Colours wrong / opposite direction*\n\n*2.1:* Swap the two strip USB plugs on the sync box; then toggle *direction* in Smart Life strip setup.\n\n*2.0:* Direction is fixed by the *bottom-left clockwise* install path — if strips were started wrong, redo placement per the video.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "tr_ps5": "*Screen flicker with PlayStation*\n\nDisable *VRR* and *HDR* in PS video settings; set HDMI to *4:2:0* if flashing continues. Confirm HDMI cables are rated for your setup.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "tr_cables": "*\"No signal\" / handshake issues*\n\nReconnect in FAQ order; try another TV HDMI port for *OUT*; swap HDMI cables one at a time. Message us with photos of cable routing if unresolved.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*.",
  "catAfterBrowse": "Tap a product card above to open details in your WhatsApp shop — or use *Main menu* below for more help."
};

function sticky(id, x, y, text, label = 'Implementation note') {
  return { id, type: 'sticky', position: { x, y }, data: { label, text } };
}

function buildFlow() {
  const nodes = [
  {
    "id": "note_main_hub",
    "type": "sticky",
    "position": {
      "x": -420,
      "y": -420
    },
    "data": {
      "label": "⚡ Hub layout",
      "text": "WhatsApp allows max *3 reply buttons* on n_main_menu (Explore / Install / Support). Track, warranty, troubleshoot, shop, and model picker live on *n_service_menu* — type phrases like *track order*, *order status*, *warranty*, *troubleshoot*, *shop*, *catalogue*, *models* (keyword trigger n_trigger_services) or use Troubleshoot → Back to hub."
    }
  },
  {
    "id": "note_csv",
    "type": "sticky",
    "position": {
      "x": -420,
      "y": -200
    },
    "data": {
      "label": "📥 Orders & CSV",
      "text": "*Order matching requires phone numbers in Shopify.*\n\nFor online orders (apexlight.in): these sync automatically when you connect Shopify in Settings → Commerce.\n\nFor offline/marketplace orders (Amazon, Meesho, etc.): export those orders as CSV with columns:\n  phone, order_id, product_name, product_sku, order_date\n\nImport via the TopEdge dashboard: Audience → Import Contacts → CSV Import.\nOnce imported, customers' phone numbers will resolve to their product and the silent order lookup will show their product image automatically."
    }
  },
  {
    "id": "note_catalog_m1",
    "type": "sticky",
    "position": {
      "x": -420,
      "y": 40
    },
    "data": {
      "label": "🛒 Catalog dual-path",
      "text": "*Method 1:* Each category has a catalog (multi) node with placeholder Shopify variant IDs — replace with real IDs from `POST /api/shopify-catalog/sync-products`. When `facebookCatalogId` is set, Meta sends product_list; when missing or send fails, the engine follows `no_catalog` to Method 2 text."
    }
  },
  {
    "id": "note_images",
    "type": "sticky",
    "position": {
      "x": -420,
      "y": 280
    },
    "data": {
      "label": "🖼 Images",
      "text": "Host wiring/cut diagrams on apexlight.in CDN. If an image URL 404s, the engine sends caption as plain text."
    }
  },
  {
    "id": "note_image_paths",
    "type": "sticky",
    "position": {
      "x": -420,
      "y": 520
    },
    "data": {
      "label": "🖼 CDN filenames",
      "text": "Suggested CDN filenames (Section 8): hdmi21_wiring.jpg, hdmi20_wiring.jpg, led_cut_points.jpg, led_corner_install.jpg — point imageUrl nodes to the final hosted URLs after upload."
    }
  },
  {
    "id": "n_trigger",
    "type": "trigger",
    "position": {
      "x": 80,
      "y": 120
    },
    "data": {
      "label": "Entry — greetings",
      "triggerType": "keyword",
      "trigger": {
        "type": "keyword",
        "channel": "whatsapp",
        "keywords": [
          "hi",
          "hello",
          "hey",
          "menu",
          "start",
          "hii",
          "hiii",
          "help",
          "apex",
          "namaste",
          "hy",
          "helo",
          "hai"
        ],
        "matchMode": "contains"
      }
    }
  },
  {
    "id": "n_trigger_first",
    "type": "trigger",
    "position": {
      "x": 80,
      "y": 280
    },
    "data": {
      "label": "Entry — first message",
      "triggerType": "first_message",
      "trigger": {
        "type": "first_message",
        "channel": "whatsapp"
      }
    }
  },
  {
    "id": "n_trigger_services",
    "type": "trigger",
    "position": {
      "x": 80,
      "y": 440
    },
    "data": {
      "label": "Entry — services keywords",
      "triggerType": "keyword",
      "trigger": {
        "type": "keyword",
        "channel": "whatsapp",
        "keywords": [
          "track order",
          "track my order",
          "order status",
          "warranty",
          "troubleshoot",
          "trouble",
          "fix",
          "model",
          "models",
          "picker",
          "shop",
          "pre-sales",
          "catalogue"
        ],
        "matchMode": "contains"
      }
    }
  },
  {
    "id": "n_welcome_logo",
    "type": "image",
    "position": {
      "x": 420,
      "y": 120
    },
    "data": {
      "label": "Welcome — Apex logo",
      "imageUrl": "https://apexlight.in/cdn/shop/files/07708086-ccae-4d21-93e2-fe0ed52b33a2.jpg?v=1714210021",
      "caption": "👋 *Welcome to Apex Light!*\n\nTurn watching and gaming into a stunning experience.\n\n💡 *What would you like to do today?*\nTap *Open menu* below to get started."
    }
  },
  {
    "id": "n_main_menu",
    "type": "interactive",
    "position": {
      "x": 760,
      "y": 120
    },
    "data": {
      "label": "Main hub — 3 buttons",
      "interactiveType": "button",
      "header": "Apex Light",
      "text": "Hi! How can we help you today?\n\n🛍️ Explore our products with prices\n📦 Get your product installed (quick guide)\n🎧 Talk to our support team",
      "buttonsList": [
        {
          "id": "btn_explore",
          "title": "Explore Products"
        },
        {
          "id": "btn_install",
          "title": "Installation Guide"
        },
        {
          "id": "btn_support",
          "title": "Contact Support"
        }
      ]
    }
  },
  {
    "id": "n_service_menu",
    "type": "interactive",
    "position": {
      "x": 760,
      "y": 380
    },
    "data": {
      "label": "Service hub — list",
      "interactiveType": "list",
      "header": "Apex Light",
      "buttonText": "More services",
      "text": "*More services*\n\nTrack an order, check warranty, troubleshoot, browse the shop, or pick your model. You can also return to the three main choices.",
      "sections": [
        {
          "title": "Services & shop",
          "rows": [
            {
              "id": "mnu_track",
              "title": "Track my order",
              "description": "Latest status"
            },
            {
              "id": "mnu_warranty",
              "title": "Warranty coverage",
              "description": "Active or expired"
            },
            {
              "id": "mnu_fix",
              "title": "Troubleshoot",
              "description": "Common symptoms"
            },
            {
              "id": "mnu_models",
              "title": "Pick my model",
              "description": "3-page list"
            },
            {
              "id": "mnu_shop",
              "title": "Shop / pre-sales",
              "description": "Catalogue + call"
            },
            {
              "id": "svc_main",
              "title": "Main choices",
              "description": "Explore / Install / Support"
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_product_menu",
    "type": "interactive",
    "position": {
      "x": 1120,
      "y": -80
    },
    "data": {
      "label": "Explore — categories",
      "interactiveType": "list",
      "buttonText": "Select category",
      "text": "✨ *Apex Light Product Catalogue*\n\nBrowse our full range of smart lighting products below. Select a category to see products with prices and direct links.",
      "sections": [
        {
          "title": "Product categories",
          "rows": [
            {
              "id": "cat_tv",
              "title": "TV Backlights",
              "description": "HDMI sync for any TV"
            },
            {
              "id": "cat_monitor",
              "title": "Monitor Sync",
              "description": "PC & monitor lighting"
            },
            {
              "id": "cat_govee",
              "title": "Govee Collection",
              "description": "Premium smart lights"
            },
            {
              "id": "cat_floor",
              "title": "Floor Lamps",
              "description": "RGBIC & uplighter"
            },
            {
              "id": "cat_gaming",
              "title": "Gaming Lights",
              "description": "Bars, hexagons & more"
            },
            {
              "id": "cat_strip",
              "title": "LED Strip Lights",
              "description": "COB, neon, edge"
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_cat_tv_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": -220
    },
    "data": {
      "label": "M1 TV — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "TV Backlights",
      "text": "Our HDMI sync TV backlights bring your screen to life. Tap any product to view and add to cart.",
      "body": "Our HDMI sync TV backlights bring your screen to life. Tap any product to view and add to cart.",
      "productIds": "SHOPIFY_VARIANT_ID_FOR_HDMI21,SHOPIFY_VARIANT_ID_FOR_HDMI20,SHOPIFY_VARIANT_ID_FOR_GOVEE_3_LITE,SHOPIFY_VARIANT_ID_FOR_HDMI20_BAR",
      "sectionTitle": "TV Backlights"
    }
  },
  {
    "id": "n_cat_monitor_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": -80
    },
    "data": {
      "label": "M1 Monitor — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "Monitor Sync",
      "text": "Monitor-sync lighting for PC and desk setups.",
      "body": "Monitor-sync lighting for PC and desk setups.",
      "productIds": "SHOPIFY_VARIANT_ID_MONITOR_BACKLIGHT,SHOPIFY_VARIANT_ID_MONITOR_BAR,SHOPIFY_VARIANT_ID_MONITOR_LAMP,SHOPIFY_VARIANT_ID_TRIANGLE,SHOPIFY_VARIANT_ID_HEX",
      "sectionTitle": "Monitor Sync"
    }
  },
  {
    "id": "n_cat_govee_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": 60
    },
    "data": {
      "label": "M1 Govee — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "Govee Collection",
      "text": "Apex-authorized Govee picks.",
      "body": "Apex-authorized Govee picks.",
      "productIds": "SHOPIFY_VARIANT_ID_GOVEE_3_LITE,SHOPIFY_VARIANT_ID_GOVEE_BARS,SHOPIFY_VARIANT_ID_GOVEE_FLOOR,SHOPIFY_VARIANT_ID_GOVEE_STRIP",
      "sectionTitle": "Govee"
    }
  },
  {
    "id": "n_cat_floor_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": 200
    },
    "data": {
      "label": "M1 Floor — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "Floor Lamps",
      "text": "Floor and table lamps with RGBIC and uplighter options.",
      "body": "Floor and table lamps with RGBIC and uplighter options.",
      "productIds": "SHOPIFY_VARIANT_ID_FLOOR_MON,SHOPIFY_VARIANT_ID_FLOOR_RGBIC,SHOPIFY_VARIANT_ID_FLOOR_UPLIGHT,SHOPIFY_VARIANT_ID_FLOOR_SPEAKER,SHOPIFY_VARIANT_ID_TABLE_RGBCW",
      "sectionTitle": "Floor lamps"
    }
  },
  {
    "id": "n_cat_gaming_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": 340
    },
    "data": {
      "label": "M1 Gaming — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "Gaming Lights",
      "text": "Gaming bars, hexagons, wall lines, and HDMI sync TV kits.",
      "body": "Gaming bars, hexagons, wall lines, and HDMI sync TV kits.",
      "productIds": "SHOPIFY_VARIANT_ID_GAMING_HDMI21,SHOPIFY_VARIANT_ID_GAMING_BARS,SHOPIFY_VARIANT_ID_GAMING_MON_BAR,SHOPIFY_VARIANT_ID_GAMING_TRI,SHOPIFY_VARIANT_ID_GAMING_HEX_L,SHOPIFY_VARIANT_ID_GAMING_HEX_S,SHOPIFY_VARIANT_ID_GAMING_WALL6,SHOPIFY_VARIANT_ID_GAMING_WALL9",
      "sectionTitle": "Gaming"
    }
  },
  {
    "id": "n_cat_strip_pl",
    "type": "catalog",
    "position": {
      "x": 1380,
      "y": 480
    },
    "data": {
      "label": "M1 Strips — product_list",
      "catalogType": "multi",
      "apexDualMethod": true,
      "header": "LED Strip Lights",
      "text": "COB, neon edge, and RGB-IC strips.",
      "body": "COB, neon edge, and RGB-IC strips.",
      "productIds": "SHOPIFY_VARIANT_ID_STRIP_COB,SHOPIFY_VARIANT_ID_STRIP_EDGE,SHOPIFY_VARIANT_ID_STRIP_NEON,SHOPIFY_VARIANT_ID_STRIP_DESK,SHOPIFY_VARIANT_ID_STRIP_RGBIC",
      "sectionTitle": "LED strips"
    }
  },
  {
    "id": "n_tv_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": -220
    },
    "data": {
      "label": "TV intro",
      "text": "📺 *TV Backlights — Our Range*\n\nAll models support HDMI sync up to 90\" TV. Tap the product links below to visit the product page and order directly."
    }
  },
  {
    "id": "n_tv_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": -220
    },
    "data": {
      "label": "TV products",
      "text": "🔆 *Apex HDMI 2.1 TV Backlight* (32-90 inch)\nPrice: Rs. 9,999\n🛒 https://apexlight.in/products/apex-hdmi-2-1-version-tv-backlight\n\n🔆 *Apex HDMI 2.0 TV Backlight* (up to 90 inch)\nPrice: Rs. 7,599\n🛒 https://apexlight.in/products/apex-hdmi-sync-tv-backlight-for-all-tv-sizes-upto-90-inches\n\n🔆 *Apex HDMI 2.0 + Bar Light* (up to 90 inch)\nPrice: Rs. 10,499\n🛒 https://apexlight.in/products/apex-hdmi-sync-tv-backlight-hdmi-sync-bar-light\n\n🔆 *Govee TV Backlight 3 Lite*\nPrice: Rs. 8,499\n🛒 https://apexlight.in/products/govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything"
    }
  },
  {
    "id": "n_tv_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": -220
    },
    "data": {
      "label": "TV CTA",
      "interactiveType": "button",
      "text": "Need help choosing? Our team is happy to suggest the right model for your TV size and setup.",
      "buttonsList": [
        {
          "id": "tv_install",
          "title": "Installation help"
        },
        {
          "id": "tv_support",
          "title": "Ask our team"
        },
        {
          "id": "tv_menu",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_monitor_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": -80
    },
    "data": {
      "label": "Monitor intro",
      "text": "📺 *Monitor Sync Lighting*\n\nBring your PC or gaming setup to life with monitor-synced colours."
    }
  },
  {
    "id": "n_monitor_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": -80
    },
    "data": {
      "label": "Monitor products",
      "text": "• *Monitor Backlight* (up to 40\") - Rs. 2,299\n  https://apexlight.in/products/apex-monitor-backlight-upto-40-inches-monitor-size-color-changing-with-screen-sync-box-pc-backlight-rgb5050-smart-led-strip-with-1-year-warranty\n\n• *Monitor Sync Bar Light* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-bar-light\n\n• *Monitor Sync Floor Lamp* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-floor-lamp\n\n• *Triangle Light (6 Pcs)* - Rs. 4,499\n  https://apexlight.in/products/apex-monitor-sync-triangle-light\n\n• *Hexagon Light (6 Pcs)* - Rs. 4,499\n  https://apexlight.in/products/apex-monitor-sync-hexagon-light"
    }
  },
  {
    "id": "n_monitor_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": -80
    },
    "data": {
      "label": "Monitor CTA",
      "interactiveType": "button",
      "text": "Would you like help with a product, or want to talk to our team?",
      "buttonsList": [
        {
          "id": "mon_pi",
          "title": "Install this product"
        },
        {
          "id": "mon_ps",
          "title": "Talk to team"
        },
        {
          "id": "mon_pm",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_govee_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": 60
    },
    "data": {
      "label": "Govee intro",
      "text": "✨ *Govee Smart Lighting — Apex Authorized*\n\nBrowse curated picks and prices below."
    }
  },
  {
    "id": "n_govee_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": 60
    },
    "data": {
      "label": "Govee products",
      "text": "• *Govee TV Backlight 3 Lite* - Rs. 8,499\n  https://apexlight.in/products/govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything\n\n• *Govee RGBIC TV Light Bars* - ~~Rs. 6,999~~ Rs. 5,499 🔥\n  https://apexlight.in/products/govee-rgbic-tv-light-bars\n\n• *Govee RGBICW Smart Floor Lamp* - ~~Rs. 7,999~~ Rs. 6,399\n  https://apexlight.in/products/govee-rgbicw-smart-floor-lamp-basic\n\n• *Govee RGBICW LED Strip Lights* - From Rs. 4,999\n  https://apexlight.in/products/govee-rgbicw-led-strip-lights"
    }
  },
  {
    "id": "n_govee_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": 60
    },
    "data": {
      "label": "Govee CTA",
      "interactiveType": "button",
      "text": "Would you like help with a product, or want to talk to our team?",
      "buttonsList": [
        {
          "id": "gov_pi",
          "title": "Install this product"
        },
        {
          "id": "gov_ps",
          "title": "Talk to team"
        },
        {
          "id": "gov_pm",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_floor_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": 200
    },
    "data": {
      "label": "Floor intro",
      "text": "🌟 *Floor Lamps & Table Lamps*\n\nBrowse our range below."
    }
  },
  {
    "id": "n_floor_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": 200
    },
    "data": {
      "label": "Floor products",
      "text": "• *Monitor Sync Floor Lamp* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-floor-lamp\n\n• *RGBICW Floor Lamp* - Rs. 4,999\n  https://apexlight.in/products/apex-rgbic-floor-lamp\n\n• *Uplighter Floor Lamp* - ~~Rs. 16,999~~ Rs. 11,999 🔥\n  https://apexlight.in/products/apex-uplighter-floor-lamp\n\n• *RGBICW Floor Lamp with Speaker* - Rs. 9,499\n  https://apexlight.in/products/apex-rgbicw-floor-lamp-with-speaker\n\n• *RGBCW Smart Table Lamp* - Rs. 1,699\n  https://apexlight.in/products/apex-rgbcw-smart-table-lamp"
    }
  },
  {
    "id": "n_floor_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": 200
    },
    "data": {
      "label": "Floor CTA",
      "interactiveType": "button",
      "text": "Would you like help with a product, or want to talk to our team?",
      "buttonsList": [
        {
          "id": "fl_pi",
          "title": "Install this product"
        },
        {
          "id": "fl_ps",
          "title": "Talk to team"
        },
        {
          "id": "fl_pm",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_gaming_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": 340
    },
    "data": {
      "label": "Gaming intro",
      "text": "🎮 *Gaming & Setup Lighting*\n\nLevel up your desk and TV zone."
    }
  },
  {
    "id": "n_gaming_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": 340
    },
    "data": {
      "label": "Gaming products",
      "text": "• *HDMI 2.1 TV Backlight* (32-90\") - Rs. 9,999\n  https://apexlight.in/products/apex-hdmi-2-1-version-tv-backlight\n\n• *Smart RGBIC Gaming Light Bars* - Rs. 5,299\n  https://apexlight.in/products/apex-smart-rgbic-gaming-light-bars\n\n• *Monitor Sync Bar Light* - Rs. 2,999\n  https://apexlight.in/products/apex-monitor-sync-bar-light\n\n• *Triangle Light (RGBIC)* - Rs. 7,999\n  https://apexlight.in/products/apex-triangle-light\n\n• *Hexagon Light (RGBIC Big)* - Rs. 7,999\n  https://apexlight.in/products/apex-hexagon-light-6-pack-6\n\n• *Hexagon Panels (Small, 10 Pcs)* - Rs. 5,499\n  https://apexlight.in/products/apex-hexagon-light-panels-small-10-piece\n\n• *Smart Wall Light Line (6 line)* - Rs. 4,999\n  https://apexlight.in/products/apex-smart-wall-light-line6-line\n\n• *Smart Wall Light Line (9 line)* - Rs. 6,999\n  https://apexlight.in/products/apex-smart-wall-light-line9-line"
    }
  },
  {
    "id": "n_gaming_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": 340
    },
    "data": {
      "label": "Gaming CTA",
      "interactiveType": "button",
      "text": "Would you like help with a product, or want to talk to our team?",
      "buttonsList": [
        {
          "id": "gm_pi",
          "title": "Install this product"
        },
        {
          "id": "gm_ps",
          "title": "Talk to team"
        },
        {
          "id": "gm_pm",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_strip_intro",
    "type": "message",
    "position": {
      "x": 1720,
      "y": 480
    },
    "data": {
      "label": "Strip intro",
      "text": "💡 *LED Strip Lights*\n\nFlexible RGB, neon, and COB options."
    }
  },
  {
    "id": "n_strip_products",
    "type": "message",
    "position": {
      "x": 1980,
      "y": 480
    },
    "data": {
      "label": "Strip products",
      "text": "• *RGBIC COB Strip Light (5M)* - Rs. 3,999\n  https://apexlight.in/products/apex-rgbic-cob-led-strip-light\n\n• *Edge Neon Light (3M)* - Rs. 4,999\n  https://apexlight.in/products/apex-edge-none-light\n\n• *Neon Rope Light (RGBIC)* - Rs. 2,999\n  https://apexlight.in/products/apex-neon-rope-light-rgbic\n\n• *Neon Rope for Desks (3M)* - Rs. 5,499\n  https://apexlight.in/products/apex-rgbic-led-neon-rope-lights-for-desks\n\n• *RGB-IC LED Strip (5M)* - Rs. 3,499\n  https://apexlight.in/products/apex-rgb-ic-led-strip-light-5m-16-4ft"
    }
  },
  {
    "id": "n_strip_cta",
    "type": "interactive",
    "position": {
      "x": 2240,
      "y": 480
    },
    "data": {
      "label": "Strip CTA",
      "interactiveType": "button",
      "text": "Would you like help with a product, or want to talk to our team?",
      "buttonsList": [
        {
          "id": "st_pi",
          "title": "Install this product"
        },
        {
          "id": "st_ps",
          "title": "Talk to team"
        },
        {
          "id": "st_pm",
          "title": "Back to menu"
        }
      ]
    }
  },
  {
    "id": "n_cat_browse_done",
    "type": "message",
    "position": {
      "x": 1980,
      "y": 620
    },
    "data": {
      "label": "After Meta product list",
      "text": "Tap a product card above to open details in your WhatsApp shop — or use *Main menu* below for more help."
    }
  },
  {
    "id": "n_buy_intro",
    "type": "message",
    "position": {
      "x": 1120,
      "y": 0
    },
    "data": {
      "label": "Purchase / pre-sales",
      "text": "Thanks for choosing *Apex Light*!\n\nIf you want to *purchase* or have *questions before you buy*, message or call us on *9328613239* — we reply fastest there.\n\nRight after this message you can also *open our WhatsApp catalogue* to see products with images and add to cart (enable Meta Catalog under Settings → Commerce if needed)."
    }
  },
  {
    "id": "n_catalog",
    "type": "catalog",
    "position": {
      "x": 1420,
      "y": 0
    },
    "data": {
      "label": "WhatsApp catalogue",
      "body": "Browse Apex products below. Tap any item for details — add to cart when checkout is enabled.",
      "text": "Browse Apex products below. Tap any item for details — add to cart when checkout is enabled.",
      "catalogType": "full"
    }
  },
  {
    "id": "n_have_pick",
    "type": "interactive",
    "position": {
      "x": 1120,
      "y": 280
    },
    "data": {
      "label": "Which product? (1/3)",
      "interactiveType": "list",
      "buttonText": "See models",
      "text": "Choose the product you *already have* (page 1 of 3):",
      "sections": [
        {
          "title": "Your Apex model",
          "rows": [
            {
              "id": "p1_hdmi21",
              "title": "HDMI 2.1 TV Backlight",
              "description": "Up to 90\""
            },
            {
              "id": "p1_hdmi20",
              "title": "HDMI 2.0 TV Backlight",
              "description": "Up to 90\""
            },
            {
              "id": "p1_hdmi20b",
              "title": "HDMI 2.0 + Bar kit",
              "description": "Up to 90\""
            },
            {
              "id": "p1_mon",
              "title": "Monitor Sync collection",
              "description": "Monitor / bar / lamp"
            },
            {
              "id": "p1_floor",
              "title": "RGBICW floor lamp",
              "description": ""
            },
            {
              "id": "p1_table",
              "title": "RGBCW table lamp",
              "description": ""
            },
            {
              "id": "p1_neon",
              "title": "RGBIC Neon rope",
              "description": "3m / 5m"
            },
            {
              "id": "p1_uplift",
              "title": "Uplighter floor lamp",
              "description": ""
            },
            {
              "id": "p1_strip5",
              "title": "RGBIC LED Strip 5m",
              "description": ""
            },
            {
              "id": "p1_more",
              "title": "➜ More models",
              "description": "Page 2"
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_have_pick2",
    "type": "interactive",
    "position": {
      "x": 1120,
      "y": 520
    },
    "data": {
      "label": "Which product? (2/3)",
      "interactiveType": "list",
      "buttonText": "See models",
      "text": "More models you may own:",
      "sections": [
        {
          "title": "Apex catalogue",
          "rows": [
            {
              "id": "p2_cob",
              "title": "RGBIC COB strip 5m",
              "description": ""
            },
            {
              "id": "p2_pixel",
              "title": "Pixel Display",
              "description": "32² / 64²"
            },
            {
              "id": "p2_edge",
              "title": "Edge Neon 3m",
              "description": ""
            },
            {
              "id": "p2_fls",
              "title": "Floor lamp + speaker",
              "description": ""
            },
            {
              "id": "p2_game",
              "title": "Gaming light bars",
              "description": ""
            },
            {
              "id": "p2_curtain",
              "title": "Curtain light 2×2m",
              "description": ""
            },
            {
              "id": "p2_deskneon",
              "title": "Neon rope for desk 3m",
              "description": ""
            },
            {
              "id": "p2_star",
              "title": "Star projector Pro",
              "description": ""
            },
            {
              "id": "p2_wall",
              "title": "Smart Wall Light Line",
              "description": "6 / 9 lines"
            },
            {
              "id": "p2_more",
              "title": "➜ More models",
              "description": "Page 3"
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_have_pick3",
    "type": "interactive",
    "position": {
      "x": 1120,
      "y": 760
    },
    "data": {
      "label": "Which product? (3/3)",
      "interactiveType": "list",
      "buttonText": "See models",
      "text": "Final models + Govee co-branded lines:",
      "sections": [
        {
          "title": "More products",
          "rows": [
            {
              "id": "p3_out",
              "title": "Smart outdoor bulb",
              "description": ""
            },
            {
              "id": "p3_gtv",
              "title": "Govee TV Backlight 3 Lite",
              "description": ""
            },
            {
              "id": "p3_gbar",
              "title": "Govee RGBIC TV bars",
              "description": ""
            },
            {
              "id": "p3_dock",
              "title": "Apex Stream Dock",
              "description": ""
            },
            {
              "id": "p3_back",
              "title": "⬆ Back to menu",
              "description": ""
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_hub21",
    "type": "interactive",
    "position": {
      "x": 1520,
      "y": 260
    },
    "data": {
      "label": "HDMI 2.1 — topic menu",
      "interactiveType": "list",
      "buttonText": "Choose topic",
      "text": "*Apex HDMI 2.1 TV Backlight* — What do you need help with?",
      "sections": [
        {
          "title": "Installation guides",
          "rows": [
            {
              "id": "h21_vid",
              "title": "Install video + basics",
              "description": "Step-by-step guide"
            },
            {
              "id": "h21_strip",
              "title": "LED strip & cutting",
              "description": "How to cut correctly"
            },
            {
              "id": "h21_hdmi",
              "title": "HDMI & syncing",
              "description": "Not syncing fix"
            },
            {
              "id": "h21_wifi",
              "title": "Smart Life / Wi-Fi",
              "description": "2.4GHz setup"
            },
            {
              "id": "h21_reset",
              "title": "Full restart steps",
              "description": "Power cycle guide"
            },
            {
              "id": "h21_ps5",
              "title": "PS5 flicker fix",
              "description": "VRR & HDR tip"
            },
            {
              "id": "h21_back",
              "title": "Back to main menu",
              "description": ""
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_hub20",
    "type": "interactive",
    "position": {
      "x": 1520,
      "y": 500
    },
    "data": {
      "label": "HDMI 2.0 — topic menu",
      "interactiveType": "list",
      "buttonText": "Choose topic",
      "text": "*Apex HDMI 2.0 TV Backlight* / *2.0 + Bar* — What do you need?",
      "sections": [
        {
          "title": "Installation guides",
          "rows": [
            {
              "id": "h20_vid",
              "title": "Install video + basics",
              "description": "Step-by-step guide"
            },
            {
              "id": "h20_strip",
              "title": "Strip & cutting rules",
              "description": "Start from bottom-left"
            },
            {
              "id": "h20_hdmi",
              "title": "HDMI & syncing",
              "description": "Not syncing fix"
            },
            {
              "id": "h20_wifi",
              "title": "Smart Life / Wi-Fi",
              "description": "2.4GHz setup"
            },
            {
              "id": "h20_reset",
              "title": "Restart + PS flicker",
              "description": "Full reset guide"
            },
            {
              "id": "h20_menu",
              "title": "Back to main menu",
              "description": ""
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_m21_install",
    "type": "image",
    "position": {
      "x": 1920,
      "y": 80
    },
    "data": {
      "label": "2.1 install diagram",
      "imageUrl": "https://apexlight.in/cdn/shop/files/hdmi21_wiring_diagram.jpg",
      "caption": "*Apex HDMI 2.1 TV Backlight* — Installation Guide\n\n*Installation video:* https://youtu.be/b82bLHryIxM?feature=shared\n\n*App to download:* Smart Life (SmartLife)\nAndroid: https://play.google.com/store/apps/details?id=com.tuya.smartlife\niOS: https://apps.apple.com/in/app/smartlife-smart-living/id1115101477\n\n📌 *The box has 2 LED strips — install both.*\nYou can start from bottom-left or bottom-right (facing TV from the back).\n\n✂️ *Cutting:* Cut only on white dotted lines between the 3 copper dots. Both strips must be cut to your TV size.\n\n🔄 *Wrong direction?* Swap the USB cables of the two strips in the sync box. Or open Smart Life → Setup → Change direction."
    }
  },
  {
    "id": "n_m21_strip",
    "type": "image",
    "position": {
      "x": 1920,
      "y": 220
    },
    "data": {
      "label": "2.1 cut diagram",
      "imageUrl": "https://apexlight.in/cdn/shop/files/hdmi21_cut_points.jpg",
      "caption": "*LED Strip & Cutting — HDMI 2.1*\n\n✅ *You MUST cut the strip to your TV size.* The sync box learns your TV size from the cut length.\n\n✂️ Cut only on the *white dotted lines* between the 3 copper dots.\n\n💡 *Leftover strip?* Keep it — you can solder it later for a larger TV.\n\n*Half strip only glowing?* Do the full restart sequence:\n1️⃣ Hold sync box button ~10s (LEDs blink)\n2️⃣ Turn off power\n3️⃣ Remove all connections\n4️⃣ Connect both strip USB cables first\n5️⃣ HDMI source → HDMI IN on sync box\n6️⃣ HDMI OUT → TV\n7️⃣ Adapter last, then power on\n\n⚠️ *Order matters. Follow every step in sequence.*\n\n*One HDMI cable in box?* That cable goes HDMI OUT → TV. Your device's existing cable goes to HDMI IN on the sync box."
    }
  },
  {
    "id": "n_m21_hdmi",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 360
    },
    "data": {
      "label": "2.1 hdmi",
      "text": "*HDMI Syncing Guide — 2.1*\n\n*Not syncing?*\nConnect an external device (PlayStation, Apple TV, Fire Stick, set-top box) to sync box *HDMI IN*, and sync box *HDMI OUT* to the TV.\n\n⚠️ *IMPORTANT:* HDMI TV backlights *do not sync with built-in smart TV apps* — you need an external HDMI source through the sync box.\n\n*Two devices on one HDMI IN?*\nNo — only one device at a time. Use an *HDMI switch/splitter* if needed.\n\n*\"No device found\" error?*\nTry the full restart sequence (HDMI IN first, then OUT, then USB, then adapter).\nTry another TV HDMI port for the OUT cable.\nSwap HDMI cables one at a time if you have spares."
    }
  },
  {
    "id": "n_m21_wifi",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 480
    },
    "data": {
      "label": "2.1 wifi",
      "text": "*Smart Life / Wi-Fi Setup — 2.1*\n\n📶 Use *2.4 GHz* Wi-Fi only.\nThe phone's Wi-Fi and the Smart Life app must be on the *same network*.\n\n*Router doesn't show 2.4 GHz separately?*\nUse another phone as a hotspot. Connect both your phone Wi-Fi AND the app to that hotspot. This setup is only needed the first time."
    }
  },
  {
    "id": "n_m21_restart",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 600
    },
    "data": {
      "label": "2.1 restart",
      "text": "*Full Restart Sequence — HDMI 2.1*\n\nFollow every step *in this exact order:*\n\n1️⃣ Hold button behind sync box ~10 seconds (LEDs blink)\n2️⃣ Turn off power\n3️⃣ Unplug everything\n4️⃣ Connect both strip USB cables\n5️⃣ Connect HDMI IN from your source device\n6️⃣ Connect HDMI OUT to TV\n7️⃣ Connect adapter and turn on\n\nStill not working?\n• Try a different TV HDMI port for the OUT cable\n• Swap HDMI cables one at a time (start with HDMI IN, then HDMI OUT)"
    }
  },
  {
    "id": "n_m21_ps5",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 720
    },
    "data": {
      "label": "2.1 PS5",
      "text": "*PlayStation Screen Flicker Fix*\n\nIf your screen goes black or flickers when using PS4/PS5 with the sync box:\n\n1️⃣ Go to PS4/PS5 *Settings → Screen and Video → Video Output*\n2️⃣ Turn off *VRR* (Variable Refresh Rate)\n3️⃣ Turn off *HDR*\n4️⃣ If still flickering: change *HDMI Format* to *4:2:0*\n\nThis resolves 95% of PlayStation compatibility issues."
    }
  },
  {
    "id": "n_m20_install",
    "type": "image",
    "position": {
      "x": 1920,
      "y": 860
    },
    "data": {
      "label": "2.0 install diagram",
      "imageUrl": "https://apexlight.in/cdn/shop/files/hdmi20_wiring_diagram.jpg",
      "caption": "*Apex HDMI 2.0 TV Backlight* — Installation Guide\n\n*Installation video:* https://youtu.be/iPyzkp_guTA?feature=shared\n\n*App to download:* Smart Life (SmartLife)\nAndroid: https://play.google.com/store/apps/details?id=com.tuya.smartlife\niOS: https://apps.apple.com/in/app/smartlife-smart-living/id1115101477\n\n📌 *Where to start:* Always start from the *bottom-left* (facing the TV from the back) and go *clockwise*. This product is designed to work ONLY this way.\n\n*Bought the kit without the bar?* Your setup has no bar lights — everything else in the video still applies."
    }
  },
  {
    "id": "n_m20_strip",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 1000
    },
    "data": {
      "label": "2.0 strip",
      "text": "*Strip & Cutting — HDMI 2.0*\n\n✂️ *Cutting is required* for correct sync.\n\nIf you don't cut: the sync box assumes a 90\" TV and syncs incorrectly.\n\nCut only on the *white dotted lines* between the 3 yellow/copper dots.\n\n*Leftover strip?* Keep it for future use (you can solder it for a larger TV).\n\n*Half strip glowing after cutting?*\n1️⃣ Hold green button on sync box ~10 seconds\n2️⃣ Turn off power\n3️⃣ Remove all connections\n4️⃣ Connect HDMI IN first\n5️⃣ Connect HDMI OUT\n6️⃣ Connect strip USB cable in the belt port\n7️⃣ Connect adapter last\n8️⃣ Turn on power\n\n⚠️ Follow every step in sequence — order matters.\n\n*\"No device\" error?* Same restart sequence, then try alternate TV HDMI ports, then try swapping HDMI cables one by one."
    }
  },
  {
    "id": "n_m20_hdmi",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 1120
    },
    "data": {
      "label": "2.0 hdmi",
      "text": "*Syncing Rules — HDMI 2.0*\n\nSame as the 2.1 family:\n\nUse an *external HDMI source* through the sync box.\nDevice → HDMI IN on sync box → HDMI OUT → TV\n\nBuilt-in smart TV apps (Netflix, YouTube) *will not drive colour sync.*\n\n*Multiple devices?* Use an HDMI switch/splitter — sync box has only one HDMI IN port."
    }
  },
  {
    "id": "n_m20_wifi",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 1240
    },
    "data": {
      "label": "2.0 wifi",
      "text": "*Smart Life / Wi-Fi — HDMI 2.0*\n\n📶 Use *2.4 GHz* Wi-Fi only.\nThe phone and app must be on the same network.\n\n*Router hiding 2.4 GHz?* Use a mobile hotspot — connect both the phone Wi-Fi and the app to it. Only needed for first-time setup."
    }
  },
  {
    "id": "n_m20_restart",
    "type": "message",
    "position": {
      "x": 1920,
      "y": 1360
    },
    "data": {
      "label": "2.0 restart",
      "text": "*Restart Sequence — HDMI 2.0*\n\n1️⃣ Hold green button ~10 seconds (product restarts)\n2️⃣ Remove power\n3️⃣ Unplug all connections\n4️⃣ Connect HDMI IN\n5️⃣ Connect HDMI OUT\n6️⃣ Connect strip USB cable in belt port\n7️⃣ Connect adapter and power on\n\n⚠️ Follow in sequence.\n\n*PlayStation flickering / screen going black?*\n→ Disable *VRR* and *HDR* in PS settings\n→ Set HDMI format to *4:2:0*"
    }
  },
  {
    "id": "n_other_products",
    "type": "interactive",
    "position": {
      "x": 1520,
      "y": 860
    },
    "data": {
      "label": "Other products — handoff",
      "interactiveType": "button",
      "text": "For Monitor Sync, floor lamps, neon lights, Govee co-branded products, and the Stream Dock — our team provides model-specific guides.\n\n📸 Send us a *photo of your product label* so we can route you to the exact instructions.\n\nOr call us directly on *9328613239*.",
      "buttonsList": [
        {
          "id": "other_support",
          "title": "Talk to support"
        },
        {
          "id": "other_models",
          "title": "Pick from model list"
        },
        {
          "id": "other_menu",
          "title": "Main menu"
        }
      ]
    }
  },
  {
    "id": "n_govee_line",
    "type": "message",
    "position": {
      "x": 1520,
      "y": 1000
    },
    "data": {
      "label": "Govee / Dock line",
      "text": "For *Govee TV Backlight 3 Lite*, *Govee RGBIC TV Light Bars*, and *Apex Stream Dock*, tell us the *exact model/size* on *9328613239* so we can route you to the right guide."
    }
  },
  {
    "id": "n_warranty",
    "type": "warranty_check",
    "position": {
      "x": 1120,
      "y": -200
    },
    "data": {
      "label": "Warranty lookup",
      "action": "WARRANTY_CHECK"
    }
  },
  {
    "id": "n_w_active",
    "type": "message",
    "position": {
      "x": 1460,
      "y": -280
    },
    "data": {
      "label": "Warranty active",
      "text": "✅ Warranty is *active* for {{_warranty_product_name|your product}}.\n\nEnds: {{_warranty_expires_display|N/A}}\nOrder ref: {{_warranty_order_ref|-}}"
    }
  },
  {
    "id": "n_w_exp",
    "type": "message",
    "position": {
      "x": 1460,
      "y": -180
    },
    "data": {
      "label": "Warranty expired",
      "text": "Warranty has expired for {{_warranty_product_name|this product}}.\nExpiry: {{_warranty_expires_display|N/A}}"
    }
  },
  {
    "id": "n_w_none",
    "type": "message",
    "position": {
      "x": 1460,
      "y": -80
    },
    "data": {
      "label": "Warranty not found",
      "text": "No warranty on file for this number yet. Share your *order ID* on *9328613239* and we will help right away."
    }
  },
  ...apexLightOwnerFlowInstallPack.nodes,
  {
    "id": "n_tr_menu",
    "type": "interactive",
    "position": {
      "x": 1120,
      "y": 120
    },
    "data": {
      "label": "Troubleshoot — list",
      "interactiveType": "list",
      "buttonText": "Issues",
      "text": "Pick the symptom that fits best:",
      "sections": [
        {
          "title": "Common fixes",
          "rows": [
            {
              "id": "t_sync",
              "title": "Not syncing to picture",
              "description": ""
            },
            {
              "id": "t_half",
              "title": "Half strip / partial glow",
              "description": ""
            },
            {
              "id": "t_wifi",
              "title": "Smart Life pairing",
              "description": ""
            },
            {
              "id": "t_color",
              "title": "Wrong colours / direction",
              "description": ""
            },
            {
              "id": "t_ps5",
              "title": "PS5 flicker / blackout",
              "description": ""
            },
            {
              "id": "t_hdmi",
              "title": "No device / cabling",
              "description": ""
            },
            {
              "id": "t_back",
              "title": "← Back to hub",
              "description": ""
            }
          ]
        }
      ]
    }
  },
  {
    "id": "n_tt1",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 80
    },
    "data": {
      "label": "T/fix — no sync",
      "text": "*Not syncing*\n\n1) Confirm *external HDMI source* flows: device → sync box HDMI *IN*, sync box HDMI *OUT* → TV.\n2) Remember: *no sync* from TV's *built-in* Netflix/YouTube apps — use Fire Stick, console, Apple TV, etc.\n3) Retry the full cable order from the FAQ (especially HDMI IN before OUT).\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_tt2",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 200
    },
    "data": {
      "label": "T/fix — half strip",
      "text": "*Half strip / only part glowing*\n\nAfter cutting to size, do a full power cycle and reconnect in *sequence*: HDMI IN → HDMI OUT → strip USB → power last.\n\nFor 2.0 follow the green-button reset steps from the FAQ pack.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_tt3",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 320
    },
    "data": {
      "label": "T/fix — app Wi‑Fi",
      "text": "*App won't connect*\n\nUse *2.4 GHz Wi-Fi* only; phone and Smart Life must be on that same network. Try a mobile hotspot once if your mesh router blocks 2.4 GHz.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_tt4",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 440
    },
    "data": {
      "label": "T/fix — colours",
      "text": "*Colours wrong / opposite direction*\n\n*2.1:* Swap the two strip USB plugs on the sync box; then toggle *direction* in Smart Life strip setup.\n\n*2.0:* Direction is fixed by the *bottom-left clockwise* install path — if strips were started wrong, redo placement per the video.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_tt5",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 560
    },
    "data": {
      "label": "T/fix — PS5",
      "text": "*Screen flicker with PlayStation*\n\nDisable *VRR* and *HDR* in PS video settings; set HDMI to *4:2:0* if flashing continues. Confirm HDMI cables are rated for your setup.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_tt6",
    "type": "message",
    "position": {
      "x": 1460,
      "y": 680
    },
    "data": {
      "label": "T/fix — cabling",
      "text": "*\"No signal\" / handshake issues*\n\nReconnect in FAQ order; try another TV HDMI port for *OUT*; swap HDMI cables one at a time. Message us with photos of cable routing if unresolved.\n\nStill stuck? Tap *Talk to human* below or send a video to *9328613239*."
    }
  },
  {
    "id": "n_order",
    "type": "order_action",
    "position": {
      "x": 1120,
      "y": 200
    },
    "data": {
      "label": "Order status",
      "actionType": "CHECK_ORDER_STATUS",
      "action": "CHECK_ORDER_STATUS"
    }
  },
  {
    "id": "n_admin_alert",
    "type": "admin_alert",
    "position": {
      "x": 1120,
      "y": 380
    },
    "data": {
      "label": "Admin alert — support",
      "topic": "Customer needs support — Apex Light",
      "alertChannel": "both",
      "priority": "high",
      "triggerSource": "WhatsApp support request"
    }
  },
  {
    "id": "n_human_handoff",
    "type": "livechat",
    "position": {
      "x": 1460,
      "y": 380
    },
    "data": {
      "label": "Live handoff",
      "notifyChannels": [
        "Dashboard",
        "WhatsApp"
      ],
      "handoffMessage": "👋 *Connecting you to our support team*\n\nOur team has been notified and will be with you shortly.\n\nFor fastest help, you can also call or message directly on *9328613239*.\n\n📸 If you have a product issue, sending a *short video or photo* helps us solve it faster."
    }
  },
  {
    "id": "n_footer",
    "type": "interactive",
    "position": {
      "x": 2280,
      "y": 360
    },
    "data": {
      "label": "Footer — loopback",
      "interactiveType": "button",
      "text": "Was that helpful? What would you like to do next?",
      "buttonsList": [
        {
          "id": "f_menu",
          "title": "Main menu"
        },
        {
          "id": "f_support",
          "title": "Talk to team"
        },
        {
          "id": "f_start",
          "title": "Start over"
        }
      ]
    }
  }
];
  const edges = [
  {
    "id": "e_t0",
    "source": "n_trigger",
    "target": "n_welcome_logo"
  },
  {
    "id": "e_t_first",
    "source": "n_trigger_first",
    "target": "n_welcome_logo"
  },
  {
    "id": "e_t_svc",
    "source": "n_trigger_services",
    "target": "n_service_menu"
  },
  {
    "id": "e_logo_menu",
    "source": "n_welcome_logo",
    "sourceHandle": "a",
    "target": "n_main_menu"
  },
  {
    "id": "e_btn_explore",
    "source": "n_main_menu",
    "sourceHandle": "btn_explore",
    "target": "n_product_menu"
  },
  {
    "id": "e_btn_install",
    "source": "n_main_menu",
    "sourceHandle": "btn_install",
    "target": "n_install_intro"
  },
  {
    "id": "e_btn_support",
    "source": "n_main_menu",
    "sourceHandle": "btn_support",
    "target": "n_admin_alert"
  },
  {
    "id": "e_svc_track",
    "source": "n_service_menu",
    "sourceHandle": "mnu_track",
    "target": "n_order"
  },
  {
    "id": "e_svc_war",
    "source": "n_service_menu",
    "sourceHandle": "mnu_warranty",
    "target": "n_warranty"
  },
  {
    "id": "e_svc_fix",
    "source": "n_service_menu",
    "sourceHandle": "mnu_fix",
    "target": "n_tr_menu"
  },
  {
    "id": "e_svc_mod",
    "source": "n_service_menu",
    "sourceHandle": "mnu_models",
    "target": "n_have_pick"
  },
  {
    "id": "e_svc_shop",
    "source": "n_service_menu",
    "sourceHandle": "mnu_shop",
    "target": "n_buy_intro"
  },
  {
    "id": "e_svc_main",
    "source": "n_service_menu",
    "sourceHandle": "svc_main",
    "target": "n_main_menu"
  },
  {
    "id": "e_cat_tv",
    "source": "n_product_menu",
    "sourceHandle": "cat_tv",
    "target": "n_cat_tv_pl"
  },
  {
    "id": "e_cat_mon",
    "source": "n_product_menu",
    "sourceHandle": "cat_monitor",
    "target": "n_cat_monitor_pl"
  },
  {
    "id": "e_cat_gov",
    "source": "n_product_menu",
    "sourceHandle": "cat_govee",
    "target": "n_cat_govee_pl"
  },
  {
    "id": "e_cat_fl",
    "source": "n_product_menu",
    "sourceHandle": "cat_floor",
    "target": "n_cat_floor_pl"
  },
  {
    "id": "e_cat_gm",
    "source": "n_product_menu",
    "sourceHandle": "cat_gaming",
    "target": "n_cat_gaming_pl"
  },
  {
    "id": "e_cat_st",
    "source": "n_product_menu",
    "sourceHandle": "cat_strip",
    "target": "n_cat_strip_pl"
  },
  {
    "id": "e_tv_nc",
    "source": "n_cat_tv_pl",
    "sourceHandle": "no_catalog",
    "target": "n_tv_intro"
  },
  {
    "id": "e_tv_intro_p",
    "source": "n_tv_intro",
    "target": "n_tv_products"
  },
  {
    "id": "e_tv_p_cta",
    "source": "n_tv_products",
    "target": "n_tv_cta"
  },
  {
    "id": "e_tv_pl_def",
    "source": "n_cat_tv_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_mon_nc",
    "source": "n_cat_monitor_pl",
    "sourceHandle": "no_catalog",
    "target": "n_monitor_intro"
  },
  {
    "id": "e_mon_chain",
    "source": "n_monitor_intro",
    "target": "n_monitor_products"
  },
  {
    "id": "e_mon_cta_e",
    "source": "n_monitor_products",
    "target": "n_monitor_cta"
  },
  {
    "id": "e_mon_pl_def",
    "source": "n_cat_monitor_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_gov_nc",
    "source": "n_cat_govee_pl",
    "sourceHandle": "no_catalog",
    "target": "n_govee_intro"
  },
  {
    "id": "e_gov_chain",
    "source": "n_govee_intro",
    "target": "n_govee_products"
  },
  {
    "id": "e_gov_cta_e",
    "source": "n_govee_products",
    "target": "n_govee_cta"
  },
  {
    "id": "e_gov_pl_def",
    "source": "n_cat_govee_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_fl_nc",
    "source": "n_cat_floor_pl",
    "sourceHandle": "no_catalog",
    "target": "n_floor_intro"
  },
  {
    "id": "e_fl_chain",
    "source": "n_floor_intro",
    "target": "n_floor_products"
  },
  {
    "id": "e_fl_cta_e",
    "source": "n_floor_products",
    "target": "n_floor_cta"
  },
  {
    "id": "e_fl_pl_def",
    "source": "n_cat_floor_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_gm_nc",
    "source": "n_cat_gaming_pl",
    "sourceHandle": "no_catalog",
    "target": "n_gaming_intro"
  },
  {
    "id": "e_gm_chain",
    "source": "n_gaming_intro",
    "target": "n_gaming_products"
  },
  {
    "id": "e_gm_cta_e",
    "source": "n_gaming_products",
    "target": "n_gaming_cta"
  },
  {
    "id": "e_gm_pl_def",
    "source": "n_cat_gaming_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_st_nc",
    "source": "n_cat_strip_pl",
    "sourceHandle": "no_catalog",
    "target": "n_strip_intro"
  },
  {
    "id": "e_st_chain",
    "source": "n_strip_intro",
    "target": "n_strip_products"
  },
  {
    "id": "e_st_cta_e",
    "source": "n_strip_products",
    "target": "n_strip_cta"
  },
  {
    "id": "e_st_pl_def",
    "source": "n_cat_strip_pl",
    "target": "n_cat_browse_done"
  },
  {
    "id": "e_cat_done_f",
    "source": "n_cat_browse_done",
    "target": "n_footer"
  },
  {
    "id": "e_tv_inst",
    "source": "n_tv_cta",
    "sourceHandle": "tv_install",
    "target": "n_install_intro"
  },
  {
    "id": "e_tv_sup",
    "source": "n_tv_cta",
    "sourceHandle": "tv_support",
    "target": "n_admin_alert"
  },
  {
    "id": "e_tv_mnu",
    "source": "n_tv_cta",
    "sourceHandle": "tv_menu",
    "target": "n_product_menu"
  },
  {
    "id": "e_pi_mon",
    "source": "n_monitor_cta",
    "sourceHandle": "mon_pi",
    "target": "n_install_intro"
  },
  {
    "id": "e_ps_mon",
    "source": "n_monitor_cta",
    "sourceHandle": "mon_ps",
    "target": "n_admin_alert"
  },
  {
    "id": "e_pm_mon",
    "source": "n_monitor_cta",
    "sourceHandle": "mon_pm",
    "target": "n_product_menu"
  },
  {
    "id": "e_pi_gov",
    "source": "n_govee_cta",
    "sourceHandle": "gov_pi",
    "target": "n_install_intro"
  },
  {
    "id": "e_ps_gov",
    "source": "n_govee_cta",
    "sourceHandle": "gov_ps",
    "target": "n_admin_alert"
  },
  {
    "id": "e_pm_gov",
    "source": "n_govee_cta",
    "sourceHandle": "gov_pm",
    "target": "n_product_menu"
  },
  {
    "id": "e_pi_fl",
    "source": "n_floor_cta",
    "sourceHandle": "fl_pi",
    "target": "n_install_intro"
  },
  {
    "id": "e_ps_fl",
    "source": "n_floor_cta",
    "sourceHandle": "fl_ps",
    "target": "n_admin_alert"
  },
  {
    "id": "e_pm_fl",
    "source": "n_floor_cta",
    "sourceHandle": "fl_pm",
    "target": "n_product_menu"
  },
  {
    "id": "e_pi_gm",
    "source": "n_gaming_cta",
    "sourceHandle": "gm_pi",
    "target": "n_install_intro"
  },
  {
    "id": "e_ps_gm",
    "source": "n_gaming_cta",
    "sourceHandle": "gm_ps",
    "target": "n_admin_alert"
  },
  {
    "id": "e_pm_gm",
    "source": "n_gaming_cta",
    "sourceHandle": "gm_pm",
    "target": "n_product_menu"
  },
  {
    "id": "e_pi_st",
    "source": "n_strip_cta",
    "sourceHandle": "st_pi",
    "target": "n_install_intro"
  },
  {
    "id": "e_ps_st",
    "source": "n_strip_cta",
    "sourceHandle": "st_ps",
    "target": "n_admin_alert"
  },
  {
    "id": "e_pm_st",
    "source": "n_strip_cta",
    "sourceHandle": "st_pm",
    "target": "n_product_menu"
  },
  {
    "id": "e_buy_cat",
    "source": "n_buy_intro",
    "target": "n_catalog"
  },
  {
    "id": "e_cat_footer",
    "source": "n_catalog",
    "target": "n_footer"
  },
  {
    "id": "e_p1_more",
    "source": "n_have_pick",
    "sourceHandle": "p1_more",
    "target": "n_have_pick2"
  },
  {
    "id": "e_p2_more",
    "source": "n_have_pick2",
    "sourceHandle": "p2_more",
    "target": "n_have_pick3"
  },
  {
    "id": "e_p3_back",
    "source": "n_have_pick3",
    "sourceHandle": "p3_back",
    "target": "n_main_menu"
  },
  {
    "id": "e_p1_21",
    "source": "n_have_pick",
    "sourceHandle": "p1_hdmi21",
    "target": "n_hub21"
  },
  {
    "id": "e_p1_20",
    "source": "n_have_pick",
    "sourceHandle": "p1_hdmi20",
    "target": "n_hub20"
  },
  {
    "id": "e_p1_20b",
    "source": "n_have_pick",
    "sourceHandle": "p1_hdmi20b",
    "target": "n_hub20"
  },
  {
    "id": "e_p1_mon",
    "source": "n_have_pick",
    "sourceHandle": "p1_mon",
    "target": "n_other_products"
  },
  {
    "id": "e_p1_fl",
    "source": "n_have_pick",
    "sourceHandle": "p1_floor",
    "target": "n_other_products"
  },
  {
    "id": "e_p1_tb",
    "source": "n_have_pick",
    "sourceHandle": "p1_table",
    "target": "n_other_products"
  },
  {
    "id": "e_p1_ne",
    "source": "n_have_pick",
    "sourceHandle": "p1_neon",
    "target": "n_other_products"
  },
  {
    "id": "e_p1_up",
    "source": "n_have_pick",
    "sourceHandle": "p1_uplift",
    "target": "n_other_products"
  },
  {
    "id": "e_p1_st",
    "source": "n_have_pick",
    "sourceHandle": "p1_strip5",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_all",
    "source": "n_have_pick2",
    "sourceHandle": "p2_cob",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_px",
    "source": "n_have_pick2",
    "sourceHandle": "p2_pixel",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_ed",
    "source": "n_have_pick2",
    "sourceHandle": "p2_edge",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_fs",
    "source": "n_have_pick2",
    "sourceHandle": "p2_fls",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_gm",
    "source": "n_have_pick2",
    "sourceHandle": "p2_game",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_cr",
    "source": "n_have_pick2",
    "sourceHandle": "p2_curtain",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_dn",
    "source": "n_have_pick2",
    "sourceHandle": "p2_deskneon",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_st",
    "source": "n_have_pick2",
    "sourceHandle": "p2_star",
    "target": "n_other_products"
  },
  {
    "id": "e_p2_wl",
    "source": "n_have_pick2",
    "sourceHandle": "p2_wall",
    "target": "n_other_products"
  },
  {
    "id": "e_p3_out",
    "source": "n_have_pick3",
    "sourceHandle": "p3_out",
    "target": "n_other_products"
  },
  {
    "id": "e_p3_gtv",
    "source": "n_have_pick3",
    "sourceHandle": "p3_gtv",
    "target": "n_govee_line"
  },
  {
    "id": "e_p3_gb",
    "source": "n_have_pick3",
    "sourceHandle": "p3_gbar",
    "target": "n_govee_line"
  },
  {
    "id": "e_p3_dk",
    "source": "n_have_pick3",
    "sourceHandle": "p3_dock",
    "target": "n_govee_line"
  },
  {
    "id": "e_w_a",
    "source": "n_warranty",
    "sourceHandle": "active",
    "target": "n_w_active"
  },
  {
    "id": "e_w_e",
    "source": "n_warranty",
    "sourceHandle": "expired",
    "target": "n_w_exp"
  },
  {
    "id": "e_w_n",
    "source": "n_warranty",
    "sourceHandle": "none",
    "target": "n_w_none"
  },
  {
    "id": "e_inst_intro_lookup",
    "source": "n_install_intro",
    "target": "n_install_lookup"
  },
  {
    "id": "e_ins_def",
    "source": "n_install_lookup",
    "target": "n_install_confirm"
  },
  {
    "id": "e_ins_noord",
    "source": "n_install_lookup",
    "sourceHandle": "no_order",
    "target": "n_install_no_order"
  },
  {
    "id": "e_no_cap",
    "source": "n_install_no_order",
    "target": "n_install_type_capture"
  },
  {
    "id": "e_ins_yes",
    "source": "n_install_confirm",
    "sourceHandle": "ins_yes",
    "target": "n_detect_model"
  },
  {
    "id": "e_ins_no",
    "source": "n_install_confirm",
    "sourceHandle": "ins_no",
    "target": "n_install_type_capture"
  },
  {
    "id": "e_ins_menu",
    "source": "n_install_confirm",
    "sourceHandle": "ins_menu",
    "target": "n_main_menu"
  },
  {
    "id": "e_dm21_t",
    "source": "n_detect_model",
    "sourceHandle": "true",
    "target": "n_hub21"
  },
  {
    "id": "e_dm21_f",
    "source": "n_detect_model",
    "sourceHandle": "false",
    "target": "n_detect_model_20"
  },
  {
    "id": "e_dm20_t",
    "source": "n_detect_model_20",
    "sourceHandle": "true",
    "target": "n_hub20"
  },
  {
    "id": "e_dm20_f",
    "source": "n_detect_model_20",
    "sourceHandle": "false",
    "target": "n_other_products"
  },
  {
    "id": "e_cap_logic",
    "source": "n_install_type_capture",
    "target": "n_detect_typed_model"
  },
  {
    "id": "e_dt21_t",
    "source": "n_detect_typed_model",
    "sourceHandle": "true",
    "target": "n_hub21"
  },
  {
    "id": "e_dt21_f",
    "source": "n_detect_typed_model",
    "sourceHandle": "false",
    "target": "n_detect_typed_20"
  },
  {
    "id": "e_dt20_t",
    "source": "n_detect_typed_20",
    "sourceHandle": "true",
    "target": "n_hub20"
  },
  {
    "id": "e_dt20_f",
    "source": "n_detect_typed_20",
    "sourceHandle": "false",
    "target": "n_typed_fallback"
  },
  {
    "id": "e_typed_f",
    "source": "n_typed_fallback",
    "target": "n_footer"
  },
  {
    "id": "e_h21_v",
    "source": "n_hub21",
    "sourceHandle": "h21_vid",
    "target": "n_m21_install"
  },
  {
    "id": "e_h21_s",
    "source": "n_hub21",
    "sourceHandle": "h21_strip",
    "target": "n_m21_strip"
  },
  {
    "id": "e_h21_h",
    "source": "n_hub21",
    "sourceHandle": "h21_hdmi",
    "target": "n_m21_hdmi"
  },
  {
    "id": "e_h21_w",
    "source": "n_hub21",
    "sourceHandle": "h21_wifi",
    "target": "n_m21_wifi"
  },
  {
    "id": "e_h21_r",
    "source": "n_hub21",
    "sourceHandle": "h21_reset",
    "target": "n_m21_restart"
  },
  {
    "id": "e_h21_p",
    "source": "n_hub21",
    "sourceHandle": "h21_ps5",
    "target": "n_m21_ps5"
  },
  {
    "id": "e_h21_b",
    "source": "n_hub21",
    "sourceHandle": "h21_back",
    "target": "n_main_menu"
  },
  {
    "id": "e_h20_v",
    "source": "n_hub20",
    "sourceHandle": "h20_vid",
    "target": "n_m20_install"
  },
  {
    "id": "e_h20_s",
    "source": "n_hub20",
    "sourceHandle": "h20_strip",
    "target": "n_m20_strip"
  },
  {
    "id": "e_h20_h",
    "source": "n_hub20",
    "sourceHandle": "h20_hdmi",
    "target": "n_m20_hdmi"
  },
  {
    "id": "e_h20_w",
    "source": "n_hub20",
    "sourceHandle": "h20_wifi",
    "target": "n_m20_wifi"
  },
  {
    "id": "e_h20_r",
    "source": "n_hub20",
    "sourceHandle": "h20_reset",
    "target": "n_m20_restart"
  },
  {
    "id": "e_h20_m",
    "source": "n_hub20",
    "sourceHandle": "h20_menu",
    "target": "n_main_menu"
  },
  {
    "id": "e_other_sup",
    "source": "n_other_products",
    "sourceHandle": "other_support",
    "target": "n_admin_alert"
  },
  {
    "id": "e_other_mod",
    "source": "n_other_products",
    "sourceHandle": "other_models",
    "target": "n_have_pick"
  },
  {
    "id": "e_other_menu",
    "source": "n_other_products",
    "sourceHandle": "other_menu",
    "target": "n_main_menu"
  },
  {
    "id": "e_admin_handoff",
    "source": "n_admin_alert",
    "target": "n_human_handoff"
  },
  {
    "id": "e_handoff_footer",
    "source": "n_human_handoff",
    "target": "n_footer"
  },
  {
    "id": "e_tr1",
    "source": "n_tr_menu",
    "sourceHandle": "t_sync",
    "target": "n_tt1"
  },
  {
    "id": "e_tr2",
    "source": "n_tr_menu",
    "sourceHandle": "t_half",
    "target": "n_tt2"
  },
  {
    "id": "e_tr3",
    "source": "n_tr_menu",
    "sourceHandle": "t_wifi",
    "target": "n_tt3"
  },
  {
    "id": "e_tr4",
    "source": "n_tr_menu",
    "sourceHandle": "t_color",
    "target": "n_tt4"
  },
  {
    "id": "e_tr5",
    "source": "n_tr_menu",
    "sourceHandle": "t_ps5",
    "target": "n_tt5"
  },
  {
    "id": "e_tr6",
    "source": "n_tr_menu",
    "sourceHandle": "t_hdmi",
    "target": "n_tt6"
  },
  {
    "id": "e_tr_b",
    "source": "n_tr_menu",
    "sourceHandle": "t_back",
    "target": "n_service_menu"
  },
  {
    "id": "e_ord_f",
    "source": "n_order",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21i",
    "source": "n_m21_install",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21s",
    "source": "n_m21_strip",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21h",
    "source": "n_m21_hdmi",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21w",
    "source": "n_m21_wifi",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21r",
    "source": "n_m21_restart",
    "target": "n_footer"
  },
  {
    "id": "e_f_m21p",
    "source": "n_m21_ps5",
    "target": "n_footer"
  },
  {
    "id": "e_f_m20i",
    "source": "n_m20_install",
    "target": "n_footer"
  },
  {
    "id": "e_f_m20s",
    "source": "n_m20_strip",
    "target": "n_footer"
  },
  {
    "id": "e_f_m20h",
    "source": "n_m20_hdmi",
    "target": "n_footer"
  },
  {
    "id": "e_f_m20w",
    "source": "n_m20_wifi",
    "target": "n_footer"
  },
  {
    "id": "e_f_m20r",
    "source": "n_m20_restart",
    "target": "n_footer"
  },
  {
    "id": "e_f_w1",
    "source": "n_w_active",
    "target": "n_footer"
  },
  {
    "id": "e_f_w2",
    "source": "n_w_exp",
    "target": "n_footer"
  },
  {
    "id": "e_f_w3",
    "source": "n_w_none",
    "target": "n_footer"
  },
  {
    "id": "e_f_g",
    "source": "n_govee_line",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt1",
    "source": "n_tt1",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt2",
    "source": "n_tt2",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt3",
    "source": "n_tt3",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt4",
    "source": "n_tt4",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt5",
    "source": "n_tt5",
    "target": "n_footer"
  },
  {
    "id": "e_f_tt6",
    "source": "n_tt6",
    "target": "n_footer"
  },
  {
    "id": "e_ff_menu",
    "source": "n_footer",
    "sourceHandle": "f_menu",
    "target": "n_main_menu"
  },
  {
    "id": "e_ff_support",
    "source": "n_footer",
    "sourceHandle": "f_support",
    "target": "n_admin_alert"
  },
  {
    "id": "e_ff_start",
    "source": "n_footer",
    "sourceHandle": "f_start",
    "target": "n_welcome_logo"
  }
];
  const removedInstallNodeIds = new Set([
    "n_install_intro",
    "n_install_lookup",
    "n_install_no_order",
    "n_install_confirm",
    "n_detect_model",
    "n_detect_model_20",
    "n_install_type_capture",
    "n_detect_typed_model",
    "n_detect_typed_20",
    "n_typed_fallback",
  ]);
  const installPackEdgeIds = new Set(apexLightOwnerFlowInstallPack.edges.map((e) => e.id));
  const mergedEdges = [
    ...edges.filter(
      (e) =>
        !installPackEdgeIds.has(e.id) &&
        !removedInstallNodeIds.has(e.source) &&
        !removedInstallNodeIds.has(e.target)
    ),
    ...apexLightOwnerFlowInstallPack.edges,
  ];
  return { nodes, edges: mergedEdges, FLOW_ID, FLOW_NAME, FLOW_DESCRIPTION };
}

module.exports = {
  buildFlow,
  FLOW_ID,
  FLOW_NAME,
  FLOW_DESCRIPTION,
};
