// email-utils.js
// SendGrid-first email sender with Nodemailer fallback for local runs.
// npm i @sendgrid/mail nodemailer

require('dotenv').config();
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');

// Environment
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || 'no-reply@example.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Son of Anton';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail';

// Exported transporter (null when using SendGrid; nodemailer transporter if fallback)
let transporter = null;

// Configure SendGrid if API key present
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('✅ SendGrid configured for outbound email.');
} else if (EMAIL_USER && EMAIL_PASS) {
  // Nodemailer fallback (useful for local dev). NOTE: many hosts block SMTP.
  transporter = nodemailer.createTransport({
    service: EMAIL_SERVICE,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    socketTimeout: 30000,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    port: 587,
    secure: false,
    tls: { rejectUnauthorized: false }
  });

  transporter.verify((err, success) => {
    if (err) {
      console.warn('⚠️ Nodemailer verify failed:', err.message || err);
    } else {
      console.log('✅ Nodemailer transporter ready (local fallback).');
    }
  });
} else {
  console.warn('⚠️ No SendGrid API key or SMTP creds found. Email sending disabled.');
}

// Escape helpers
function escapeHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(str) {
  if (!str && str !== 0) return '#';
  return String(str).replace(/"/g, '%22').replace(/'/g, '%27');
}

// Build HTML email - cleaner UI, responsive cards, CTA buttons, plain-text fallback
function buildEmailHtml({ user, searchParty, deals }) {
  const itemName = escapeHtml(searchParty.itemName || 'your item');
  const priceFilter = searchParty.maxPrice ? `<div style="font-size:14px;color:#666;margin-top:4px;"><strong>Max Price:</strong> $${escapeHtml(searchParty.maxPrice)}</div>` : '';
  const preferences = searchParty.preferences ? `<div style="font-size:14px;color:#666;margin-top:4px;"><strong>Preferences:</strong> ${escapeHtml(searchParty.preferences)}</div>` : '';

  const dealCards = (deals && deals.length)
    ? deals.map(d => {
        const title = escapeHtml(d.title || 'Unknown product');
        const price = (typeof d.price === 'number') ? `$${d.price.toFixed(2)}` : escapeHtml(d.price || 'N/A');
        const source = escapeHtml(d.source || 'Seller');
        const link = escapeAttr(d.link || '#');
        const image = escapeAttr(d.image || '');
        const rating = d.rating && d.reviews ? `<div style="font-size:13px;color:#888;margin-top:6px;display:flex;align-items:center;gap:4px;"><span style="color:#f59e0b;">★</span> ${escapeHtml(d.rating)} • ${escapeHtml(d.reviews)} reviews</div>` : '';

        return `
          <div style="background:#fff;border-radius:12px;overflow:hidden;margin-bottom:16px;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <table role="presentation" width="100%" style="border-collapse:collapse;">
              <tr>
                <td style="width:180px;padding:16px;vertical-align:top;border-right:1px solid #f3f4f6;">
                  <div style="background:#f9fafb;border-radius:8px;padding:12px;display:flex;align-items:center;justify-content:center;min-height:140px;">
                    ${image ? `<img src="${image}" alt="${title}" style="max-width:100%;max-height:140px;object-fit:contain;display:block;">` : `<div style="color:#d1d5db;font-size:14px;text-align:center;">No image<br>available</div>`}
                  </div>
                </td>
                <td style="padding:16px;vertical-align:top;">
                  <div style="margin-bottom:8px;">
                    <a href="${link}" target="_blank" rel="noopener noreferrer" style="color:#111827;text-decoration:none;font-size:16px;font-weight:600;line-height:1.4;display:block;">${title}</a>
                  </div>
                  <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">
                    <span style="font-size:24px;font-weight:700;color:#059669;">${price}</span>
                    <span style="font-size:14px;color:#6b7280;">from ${source}</span>
                  </div>
                  ${rating}
                  <div style="margin-top:14px;">
                    <a href="${link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;box-shadow:0 2px 4px rgba(102,126,234,0.3);">View Deal →</a>
                  </div>
                </td>
              </tr>
            </table>
          </div>
        `;
      }).join('')
    : `<div style="padding:24px;text-align:center;color:#9ca3af;background:#f9fafb;border-radius:8px;border:1px dashed #e5e7eb;">No deals found matching your criteria.</div>`;

  // Final HTML
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111827;">
    <center style="width:100%;table-layout:fixed;">
      <div style="max-width:680px;margin:32px auto;">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:32px 24px;border-radius:16px 16px 0 0;text-align:center;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <div style="font-size:28px;font-weight:700;color:#fff;margin-bottom:8px;">🎯 Deals Found!</div>
          <div style="font-size:18px;color:rgba(255,255,255,0.95);font-weight:500;">${itemName}</div>
          <div style="margin-top:12px;font-size:13px;color:rgba(255,255,255,0.8);">Sent by ${escapeHtml(FROM_NAME)}</div>
        </div>

        <!-- Main Content -->
        <div style="background:#fff;padding:32px 24px;border-radius:0 0 16px 16px;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <p style="margin:0 0 20px 0;font-size:16px;color:#374151;line-height:1.6;">Hi <strong>${escapeHtml(user.username || 'there')}</strong>,</p>
          <p style="margin:0 0 24px 0;font-size:16px;color:#374151;line-height:1.6;">I found the latest deals for <strong>${itemName}</strong>. Here's what matches your search:</p>

          <!-- Search Details -->
          <div style="background:linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%);padding:16px 20px;border-radius:10px;margin-bottom:28px;border-left:4px solid #0ea5e9;">
            <div style="font-weight:700;color:#0c4a6e;margin-bottom:8px;font-size:15px;">📋 Search Details</div>
            <div style="font-size:14px;color:#0c4a6e;line-height:1.6;">
              <strong>Item:</strong> ${escapeHtml(searchParty.itemName || '')}
              ${priceFilter}
              ${preferences}
            </div>
          </div>

          <!-- Deals Section -->
          <div style="margin-bottom:28px;">
            <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:16px;">🛍️ Top Deals</div>
            ${dealCards}
          </div>

          <!-- Tip Box -->
          <div style="background:#fffbeb;padding:16px 20px;border-radius:10px;border-left:4px solid #f59e0b;margin-bottom:24px;">
            <div style="font-weight:700;color:#92400e;margin-bottom:6px;font-size:15px;">💡 Pro Tip</div>
            <div style="font-size:14px;color:#78350f;line-height:1.6;">Prices can change quickly! Click "View Deal" to lock in these prices. Want more frequent updates? Enable auto-monitoring in your account.</div>
          </div>

          <!-- CTA Button -->
          <div style="text-align:center;margin-bottom:24px;">
            <a href="#" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;box-shadow:0 4px 6px rgba(102,126,234,0.4);">Open Dashboard</a>
          </div>

          <!-- Footer Note -->
          <div style="text-align:center;font-size:13px;color:#9ca3af;line-height:1.5;padding-top:20px;border-top:1px solid #e5e7eb;">
            You received this email because you created a Search Party.<br>
            Manage your notifications in your account settings.
          </div>
        </div>

        <!-- Email Footer -->
        <div style="text-align:center;margin-top:20px;color:#9ca3af;font-size:13px;">
          Happy shopping! 🛒<br>
          <strong style="color:#6b7280;">${escapeHtml(FROM_NAME)}</strong>
        </div>
      </div>
    </center>
  </body>
  </html>
  `;
}

// Plain-text fallback
function buildPlainText({ user, searchParty, deals }) {
  const header = `Deals found for "${searchParty.itemName}"\n\n`;
  const details = `Search details:\n- Item: ${searchParty.itemName}\n${searchParty.maxPrice ? `- Max price: $${searchParty.maxPrice}\n` : ''}${searchParty.preferences ? `- Preferences: ${searchParty.preferences}\n` : ''}\n`;
  const dealsText = (deals && deals.length) ? deals.map((d, i) => {
    return `${i + 1}. ${d.title}\n   Price: ${typeof d.price === 'number' ? `$${d.price.toFixed(2)}` : d.price}\n   Seller: ${d.source}\n   Link: ${d.link}\n`;
  }).join('\n') : 'No deals found.\n';

  return `${header}${details}\nTop deals:\n${dealsText}\nSent by ${FROM_NAME}\n`;
}

// sendDealEmail: uses SendGrid if available else Nodemailer transporter fallback
async function sendDealEmail(user, searchParty, deals = []) {
  if (!user || !user.email) {
    console.warn('No recipient email provided.');
    return false;
  }

  const msgHtml = buildEmailHtml({ user, searchParty, deals });
  const plain = buildPlainText({ user, searchParty, deals });
  const subject = `Deals found for "${searchParty.itemName}"`;

  // Try SendGrid first
  if (SENDGRID_API_KEY) {
    const msg = {
      to: user.email,
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      subject,
      text: plain,
      html: msgHtml
    };

    try {
      await sgMail.send(msg);
      console.log(`✅ SendGrid: Email sent to ${user.email} for "${searchParty.itemName}"`);
      return true;
    } catch (err) {
      console.error('❌ SendGrid send error:', err?.response?.body || err.message || err);
      // fallthrough to transporter if configured
    }
  }

  // Nodemailer fallback (useful for local dev only; many hosts block SMTP)
  if (transporter) {
    const mailOptions = {
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: user.email,
      subject,
      html: msgHtml,
      text: plain,
      timeout: 30000
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ SMTP: Email sent to ${user.email} for "${searchParty.itemName}"`);
      return true;
    } catch (err) {
      console.error('❌ SMTP send error:', err && err.message ? err.message : err);
      return false;
    }
  }

  console.warn('No email provider configured (SendGrid missing, SMTP missing). Skipping send.');
  return false;
}

module.exports = {
  transporter,
  sendDealEmail
};