"use strict";

const express = require('express');
const Client = require('../models/Client');
const Notification = require('../models/Notification');
const { emitAdminNotification } = require('../utils/admin/emitAdminNotification');
const { parsePlatformReviewToken } = require('../utils/core/platformReviewToken');

const router = express.Router();

function renderSurveyPage({ token, clientName, ratingPrefill = null, submitted = false, highRating = false }) {
  const publicReviewUrl = String(process.env.PUBLIC_REVIEW_URL || '').trim();
  const stars = [1, 2, 3, 4, 5];
  const selected = Number(ratingPrefill || 0);
  const thanksTitle = highRating ? 'Thank you for the rating!' : 'Thanks for your feedback';
  const thanksCopy = highRating
    ? 'We appreciate your support. If you have 30 seconds, please leave a public review as well.'
    : "Thanks for sharing this honestly. Our ops team will follow up and help improve your experience.";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TopEdge Review</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; background:#f8fafc; margin:0; padding:24px; color:#0f172a; }
    .card { max-width:560px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:24px; }
    .stars { display:flex; gap:8px; margin:12px 0 16px; }
    .star-btn { border:1px solid #ddd6fe; background:#f5f3ff; color:#6d28d9; border-radius:999px; padding:8px 12px; cursor:pointer; font-weight:700; }
    .star-btn.active { background:#7c3aed; color:#fff; border-color:#7c3aed; }
    textarea { width:100%; min-height:100px; border:1px solid #cbd5e1; border-radius:12px; padding:10px; font-family:inherit; }
    .btn { margin-top:14px; border:0; background:#7c3aed; color:#fff; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
    .subtle { color:#64748b; font-size:14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${submitted ? thanksTitle : `How is your TopEdge experience, ${clientName || 'there'}?`}</h2>
    <p class="subtle">${submitted ? thanksCopy : 'Rate from 1 (needs work) to 5 (excellent). Optional note below.'}</p>
    ${
      submitted
        ? `${
            highRating && publicReviewUrl
              ? `<p><a href="${publicReviewUrl}" target="_blank" rel="noreferrer">Leave a public review</a></p>`
              : ''
          }`
        : `<form method="POST" action="/survey/${token}">
            <div class="stars">
              ${stars
                .map(
                  (v) =>
                    `<button class="star-btn ${selected === v ? 'active' : ''}" type="button" data-star="${v}">${'★'.repeat(v)}</button>`
                )
                .join('')}
            </div>
            <input type="hidden" id="rating" name="rating" value="${selected || ''}" />
            <textarea name="comment" placeholder="Any concern or feedback (optional)"></textarea>
            <button class="btn" type="submit">Submit feedback</button>
          </form>
          <script>
            document.querySelectorAll('[data-star]').forEach((el) => {
              el.addEventListener('click', () => {
                const val = Number(el.getAttribute('data-star'));
                document.getElementById('rating').value = val;
                document.querySelectorAll('[data-star]').forEach((btn) => btn.classList.remove('active'));
                el.classList.add('active');
              });
            });
          </script>`
    }
  </div>
</body>
</html>`;
}

router.get('/:token', async (req, res) => {
  const parsed = parsePlatformReviewToken(req.params.token);
  if (!parsed?.clientId) return res.status(404).type('text/plain').send('Invalid survey link');
  const client = await Client.findOne({ clientId: parsed.clientId }).select('name businessName').lean();
  if (!client) return res.status(404).type('text/plain').send('Client not found');
  return res.status(200).send(
    renderSurveyPage({
      token: req.params.token,
      clientName: client.name || client.businessName || parsed.clientId,
      ratingPrefill: parsed.ratingPrefill,
    })
  );
});

router.post('/:token', express.urlencoded({ extended: true }), async (req, res) => {
  const parsed = parsePlatformReviewToken(req.params.token);
  if (!parsed?.clientId) return res.status(404).type('text/plain').send('Invalid survey link');

  const rating = Number(req.body?.rating || 0);
  const comment = String(req.body?.comment || '').trim().slice(0, 1500);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).type('text/plain').send('Please select a rating between 1 and 5.');
  }

  const client = await Client.findOneAndUpdate(
    { clientId: parsed.clientId },
    {
      $set: {
        platformReviewRating: rating,
        platformReviewComment: comment,
        platformReviewSentAt: new Date(),
      },
    },
    { new: true }
  ).lean();
  if (!client) return res.status(404).type('text/plain').send('Client not found');

  if (rating <= 3) {
    const doc = await Notification.create({
      clientId: 'TOPEDGE_ADMIN',
      title: 'Low platform review received',
      message: `${client.name || client.businessName || client.clientId} rated ${rating}/5${comment ? ` — "${comment.slice(0, 120)}"` : ''}`,
      type: 'system',
      status: 'unread',
      metadata: { clientId: client.clientId, rating, comment },
    });
    emitAdminNotification(doc);
  }

  return res.status(200).send(
    renderSurveyPage({
      token: req.params.token,
      clientName: client.name || client.businessName || client.clientId,
      submitted: true,
      highRating: rating >= 4,
    })
  );
});

module.exports = router;
