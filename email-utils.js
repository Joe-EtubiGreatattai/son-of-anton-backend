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
  const priceFilter = searchParty.maxPrice ? `<div style="font-size:14px;color:#555;margin-top:6px;"><strong>Max Price:</strong> $${escapeHtml(searchParty.maxPrice)}</div>` : '';
  const preferences = searchParty.preferences ? `<div style="font-size:14px;color:#555;margin-top:6px;"><strong>Preferences:</strong> ${escapeHtml(searchParty.preferences)}</div>` : '';

  const dealCards = (deals && deals.length)
    ? deals.map(d => {
        const title = escapeHtml(d.title || 'Unknown product');
        const price = (typeof d.price === 'number') ? `$${d.price.toFixed(2)}` : escapeHtml(d.price || 'N/A');
        const source = escapeHtml(d.source || 'Seller');
        const link = escapeAttr(d.link || '#');
        const image = escapeAttr(d.image || '');
        const rating = d.rating && d.reviews ? `${escapeHtml(d.rating)} • ${escapeHtml(d.reviews)} reviews` : '';

        return `
          <td style="padding:12px;vertical-align:top;width:50%;">
            <div style="border-radius:12px;overflow:hidden;border:1px solid #e6e9ef;background:#fff;">
              <div style="min-height:120px;display:flex;align-items:center;justify-content:center;background:#fafbff;">
                ${image ? `<img src="${image}" alt="${title}" style="max-width:100%;max-height:120px;object-fit:contain;">` : `<div style="width:100%;height:120px;display:flex;align-items:center;justify-content:center;color:#999;">No image</div>`}
              </div>
              <div style="padding:12px 14px;">
                <div style="font-weight:600;font-size:15px;margin-bottom:6px;"><a href="${link}" target="_blank" rel="noopener noreferrer" style="color:#0b63d6;text-decoration:none;">${title}</a></div>
                <div style="color:#111;font-weight:700;font-size:16px;margin-bottom:8px;">${price} <span style="font-size:13px;color:#666;font-weight:500">• ${source}</span></div>
                <div style="font-size:13px;color:#666;margin-bottom:10px;">${rating}</div>
                <div style="text-align:right;"><a href="${link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:8px 12px;border-radius:8px;background:#0b63d6;color:#fff;text-decoration:none;font-size:14px;">View Deal</a></div>
              </div>
            </div>
          </td>
        `;
      }).join('')
    : `<tr><td>No deals found.</td></tr>`;

  // Two-column grid: wrap every 2 items in a row
  let gridHtml = '';
  if (deals && deals.length) {
    for (let i = 0; i < deals.length; i += 2) {
      const left = deals[i];
      const right = deals[i + 1];
      const leftCard = dealCards.split('</td>')[i] ? '' : ''; // placeholder (we'll build using mapping above)
      gridHtml += `<tr>${dealCards.split('</td>').slice(i*1, i*1+2).join('</td>')}</tr>`;
    }
    // Simpler: render all cards inside a single row with table; above mapping already produces <td> fragments, so just wrap:
    gridHtml = `<tr>${dealCards}</tr>`;
  } else {
    gridHtml = `<tr><td style="padding:12px;color:#666;">No deals matched your criteria.</td></tr>`;
  }

  // Final HTML
  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;">
    <center style="width:100%;table-layout:fixed;">
      <div style="max-width:700px;margin:28px auto;">
        <table role="presentation" width="100%" style="border-collapse:collapse;">
          <tr>
            <td style="background:linear-gradient(90deg,#667eea,#764ba2);padding:28px;border-radius:12px 12px 0 0;color:#fff;text-align:center;">
              <h1 style="margin:0;font-size:22px;">Search Party — Deals found for <span style="white-space:nowrap">${itemName}</span></h1>
              <div style="margin-top:8px;font-size:14px;opacity:0.95;">Sent by ${escapeHtml(FROM_NAME)}</div>
            </td>
          </tr>

          <tr>
            <td style="background:#fff;padding:22px;border:1px solid #e9edf5;border-top:none;border-radius:0 0 12px 12px;">
              <p style="margin:0 0 12px 0;font-size:15px;">Hi ${escapeHtml(user.username || 'there')}, I found the latest matches for <strong>${itemName}</strong>.</p>

              <div style="background:#f7f9ff;padding:12px;border-radius:8px;margin-bottom:16px;border:1px solid #eef2ff;">
                <div style="font-weight:600;color:#333;margin-bottom:6px;">Search details</div>
                <div style="font-size:14px;color:#555;">${escapeHtml(searchParty.itemName || '')}${priceFilter}${preferences}</div>
              </div>

              <table role="presentation" width="100%" style="border-collapse:separate;border-spacing:12px 12px;">
                ${gridHtml}
              </table>

              <div style="margin-top:18px;padding:14px;border-radius:8px;background:#fff8e6;border-left:4px solid #ffd966;">
                <div style="font-weight:600;color:#8a6d00;margin-bottom:6px;">Tip</div>
                <div style="font-size:14px;color:#5e4b00;">Prices change fast — click the "View Deal" button to claim a price. If you'd like, I can auto-monitor this item more frequently.</div>
              </div>

              <div style="margin-top:18px;text-align:center;">
                <a href="#" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#667eea;color:#fff;text-decoration:none;font-weight:600;">Open app</a>
              </div>

              <div style="margin-top:18px;font-size:12px;color:#888;text-align:center;">
                You received this email because you set up a Search Party. Manage notifications in your account.
              </div>
            </td>
          </tr>
        </table>

        <div style="text-align:center;margin-top:14px;color:#999;font-size:12px;">Happy shopping — Son of Anton 🛍️</div>
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
