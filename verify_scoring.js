
const mongoose = require('mongoose');
const { updateLeadWithScoring } = require('./utils/leadScoring');
const AdLead = require('./models/AdLead');

async function testScoring() {
  try {
    // Connect to a local test DB if needed, but here we just want to test logic.
    // Since we are in the real workspace, we should be careful.
    // However, I can just mock the model or run a controlled test if MongoDB is running.
    
    console.log("Testing Scoring Pipeline...");
    
    // Test 1: Increment orders to 5 (Should trigger Hot/100)
    const phoneNumber = "1234567890";
    const clientId = "test_client";
    
    // We'll just print the pipeline output for verification
    const { buildScoringPipeline } = require('./utils/leadScoring');
    
    console.log("\n--- TEST 1: Hot Tier (Orders >= 5) ---");
    const pipeline1 = buildScoringPipeline({ ordersCount: 5 }, { cartStatus: "purchased" }, {});
    console.log(JSON.stringify(pipeline1, null, 2));
    
    console.log("\n--- TEST 2: Warm Tier (Orders >= 2) ---");
    const pipeline2 = buildScoringPipeline({ ordersCount: 2 }, { cartStatus: "purchased" }, {});
    console.log(JSON.stringify(pipeline2, null, 2));
    
    console.log("\n--- TEST 3: Abandoned Cart Tier ---");
    const pipeline3 = buildScoringPipeline({ addToCartCount: 1 }, { cartStatus: "abandoned" }, {});
    console.log(JSON.stringify(pipeline3, null, 2));

    console.log("\n--- TEST 4: RTO Risk Reset ---");
    const pipeline4 = buildScoringPipeline({ ordersCount: 1 }, { cartStatus: "purchased" }, { isRtoRisk: false });
    console.log(JSON.stringify(pipeline4, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

testScoring();
