const { generateEcommerceFlow } = require("./utils/flowGenerator");

async function runDemo() {
  const client = { clientId: "demo_client_123", geminiApiKey: "mock_key" };
  const wizardData = {
    businessName: "TopEdge Enterprise",
    businessDescription: "Premium Gadgets & Electronics",
    activePersona: "concierge",
    b2bEnabled: true,
    warrantyDuration: "2 Years",
    warrantyPolicy: "Includes accidental damage protection.",
    products: [
      { name: "iPhone 15 Pro", price: "129999", category: "Mobiles", imageUrl: "https://example.com/iphone.jpg", description: "Titanium build." },
      { name: "iPhone 14",     price: "69999",  category: "Mobiles", imageUrl: "https://example.com/iphone14.jpg" },
      { name: "MacBook Air M3", price: "114999", category: "Laptops", imageUrl: "https://example.com/macbook.jpg", description: "Thin, light." },
      { name: "MacBook Pro M2", price: "199999", category: "Laptops", imageUrl: "https://example.com/mbp.jpg" }
    ],
    botName: "TopBot",
    tone: "professional",
    botLanguage: "English",
    cartTiming: { msg1: 15, msg2: 120, msg3: 1440 },
    faqText: "Shipping takes 24 hours. Warranty is 1 year.",
    adminPhone: "919876543210",
    openTime: "09:00",
    closeTime: "20:00",
    workingDays: [1, 2, 3, 4, 5, 6],
    referralPoints: 1000,
    signupPoints: 250,
  };

  try {
    const flow = await generateEcommerceFlow(client, wizardData);
    console.log("DEMO FLOW GENERATED SUCCESSFULLY");
    console.log("Nodes Count:", flow.nodes.length);
    console.log("Edges Count:", flow.edges.length);
    console.log("--- Samples ---");
    console.log("First Node:", JSON.stringify(flow.nodes[0], null, 2));
    console.log("Last Node:", JSON.stringify(flow.nodes[flow.nodes.length - 1], null, 2));
    
    // Save to a file for deeper inspection
    const fs = require('fs');
    fs.writeFileSync('./demo_flow_output.json', JSON.stringify(flow, null, 2));
    console.log("Full flow saved to ./demo_flow_output.json");
  } catch (err) {
    console.error("Demo failed:", err);
  }
}

runDemo();
