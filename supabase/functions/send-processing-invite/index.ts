// =============================================================================
// Roost — send-processing-invite
//
// The third (and only other) part of Roost that runs on a server, because it
// is the only other operation that needs a secret the browser can't hold —
// here, a transactional-email API key (Resend) instead of the service_role
// key or an Anthropic key.
//
// Unlike the invoice follow-ups, this one really does send mail on its own.
// That is a deliberate difference, not an oversight: a calendar file cannot
// be attached to a mailto: link, so there is no "open the person's own email
// app" option here the way there is for follow-ups. Sending was the only way
// to do what was actually asked for. What stays true to the rest of Roost:
// only an owner can trigger it (RLS backs this, not just this function), and
// nothing is invented — every fact in the email and the calendar file comes
// straight from the booking row, not from a model.
//
// PUBLISH, not REQUEST: this announces an event, it does not run a meeting
// invitation with RSVP tracking. Roost has no inbound mail handling, so an
// ATTENDEE/RSVP flow would show "Yes/No/Maybe" buttons whose replies go
// nowhere — a dead end pretending to be a feature. PUBLISH is the honest
// choice for a farm telling people a date, not negotiating one.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/* ---------- iCalendar (RFC 5545) -------------------------------------------- */

// Text values need their own escaping — a comma or semicolon in a farm's own
// notes would otherwise corrupt the file for every recipient.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// Lines over 75 octets must be folded (CRLF + a leading space) or some
// calendar apps will silently drop or mangle the property.
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 75 : 74; // continuation lines lose one column to the leading space
    let chunk = rest.slice(0, limit);
    // Never split a multi-byte character in half.
    while (new TextEncoder().encode(chunk).length > limit) chunk = chunk.slice(0, -1);
    parts.push(chunk);
    rest = rest.slice(chunk.length);
    first = false;
  }
  return parts.join('\r\n ');
}

function fmtDateStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

interface BookingFacts {
  bookingId: number;
  farmName: string;
  cycleLabel: string;
  bookedOn: string;       // YYYY-MM-DD
  bookedTime: string | null; // HH:MM:SS or null
  location: string | null;
  notes: string | null;
  sequence: number;
  birdsIntended: number | null; // the farm's stated plan, not a live count
}

// A date-only booking becomes a whole-day event, with no timezone to get
// wrong. A timed booking is left "floating" — no Z, no TZID — which every
// calendar app shows at face value in whatever timezone the phone itself is
// set to. That is the right call here: everyone this goes to is physically
// at the same farm at the same real clock time, and Roost tracks no farm
// timezone anywhere else either. If that stops being true, this is the line
// to revisit.
function buildEvent(f: BookingFacts): string {
  const [y, mo, d] = f.bookedOn.split('-').map(Number);
  const uid = `processing-booking-${f.bookingId}@roost.app`;
  const summary = `Processing day — ${f.cycleLabel}`;

  const lines: string[] = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${fmtDateStamp(new Date())}`);
  lines.push(`SEQUENCE:${f.sequence}`);
  lines.push('STATUS:CONFIRMED');

  if (f.bookedTime) {
    const [hh, mm, ss] = f.bookedTime.split(':').map(Number);
    const start = `${y}${pad(mo)}${pad(d)}T${pad(hh)}${pad(mm)}${pad(ss || 0)}`;
    // A two-hour placeholder — long enough to not look instantaneous, short
    // enough not to claim a duration nobody told Roost.
    const endDate = new Date(y, mo - 1, d, hh, mm, ss || 0);
    endDate.setHours(endDate.getHours() + 2);
    const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}` +
      `T${pad(endDate.getHours())}${pad(endDate.getMinutes())}${pad(endDate.getSeconds())}`;
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
  } else {
    const endDate = new Date(y, mo - 1, d + 1); // DTEND is exclusive for all-day events
    const startStr = `${y}${pad(mo)}${pad(d)}`;
    const endStr = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}`;
    lines.push(`DTSTART;VALUE=DATE:${startStr}`);
    lines.push(`DTEND;VALUE=DATE:${endStr}`);
  }

  lines.push(foldLine(`SUMMARY:${escapeText(summary)}`));
  if (f.location) lines.push(foldLine(`LOCATION:${escapeText(f.location)}`));

  // A real newline here, not a pre-escaped one — escapeText() below is what
  // turns it into the single \n an ICS reader expects. Pre-escaping it first
  // just gets escaped a second time on top.
  const descParts = [`${f.farmName} — ${f.cycleLabel}`];
  if (f.birdsIntended) descParts.push(`${f.birdsIntended} bird${f.birdsIntended === 1 ? '' : 's'}`);
  if (f.notes) descParts.push(f.notes);
  lines.push(foldLine(`DESCRIPTION:${escapeText(descParts.join('\n\n'))}`));

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function buildCalendar(f: BookingFacts): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Roost//Processing Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    buildEvent(f),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/* ---------- The function ----------------------------------------------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { booking_id?: number; emails?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body' }, 400);
  }

  const bookingId = body.booking_id;
  if (!bookingId) return json({ error: 'booking_id is required' }, 400);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const FROM_ADDRESS = Deno.env.get('PROCESSING_INVITE_FROM') || 'Roost <onboarding@resend.dev>';

  if (!RESEND_API_KEY) {
    return json({
      error: 'RESEND_API_KEY is not set for this project. Add it under ' +
        'Edge Functions → Secrets in the Supabase dashboard, then try again.',
    }, 500);
  }

  // Acts as the caller for every read and write — this function has no
  // authority of its own over farm data, only over the one external call
  // that needs a secret the browser can't hold.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: 'Not signed in' }, 401);

  const { data: canOwn } = await userClient.rpc('can_own_booking', { p_booking_id: bookingId });
  if (!canOwn) {
    return json({ error: 'Only an owner can send invites for this booking' }, 403);
  }

  const { data: booking, error: bookingErr } = await userClient
    .from('processing_bookings')
    .select('id, farm_id, cycle_id, booked_on, booked_time, location, notes, sequence_no, birds_intended')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr) return json({ error: bookingErr.message }, 400);
  if (!booking) return json({ error: 'That booking does not exist, or you do not have access to it' }, 404);

  const [{ data: farm }, { data: cycle }] = await Promise.all([
    userClient.from('farms').select('name').eq('id', booking.farm_id).maybeSingle(),
    userClient.from('cycles').select('label').eq('id', booking.cycle_id).maybeSingle(),
  ]);

  // Which invites to (re)send: the ones named explicitly, or — left
  // unspecified — everything not already sent for this exact booking
  // sequence, which naturally covers both brand-new recipients and anyone
  // left stale by a reschedule.
  let query = userClient
    .from('processing_booking_invites')
    .select('id, email, name')
    .eq('booking_id', bookingId);

  if (body.emails && body.emails.length) {
    query = query.in('email', body.emails);
  } else {
    query = query.or(`sent_at.is.null,sent_for_seq.neq.${booking.sequence_no}`);
  }

  const { data: invites, error: invitesErr } = await query;
  if (invitesErr) return json({ error: invitesErr.message }, 400);
  if (!invites || !invites.length) {
    return json({ ok: true, sent: 0, failed: 0, message: 'Nothing to send — everyone is already invited.' });
  }

  const facts: BookingFacts = {
    bookingId: booking.id,
    farmName: farm?.name ?? 'the farm',
    cycleLabel: cycle?.label ?? 'this cycle',
    bookedOn: booking.booked_on,
    bookedTime: booking.booked_time,
    location: booking.location,
    notes: booking.notes,
    sequence: booking.sequence_no,
    birdsIntended: booking.birds_intended,
  };

  const ics = buildCalendar(facts);
  const icsBase64 = btoa(unescape(encodeURIComponent(ics)));

  const whenText = booking.booked_time
    ? `${booking.booked_on} at ${booking.booked_time.slice(0, 5)}`
    : booking.booked_on;

  // Whatever the farm said at booking time, exactly as they said it — this
  // function has no live bird count of its own to check it against, and
  // shouldn't invent a claim of accuracy plans do not have.
  const birdsText = facts.birdsIntended
    ? ` — ${facts.birdsIntended} bird${facts.birdsIntended === 1 ? '' : 's'}`
    : '';

  let sent = 0;
  let failed = 0;

  for (const invite of invites) {
    const html =
      `<p>${facts.farmName} has booked processing for <strong>${facts.cycleLabel}</strong> ` +
      `on <strong>${whenText}</strong>${facts.location ? ` at ${facts.location}` : ''}${birdsText}.</p>` +
      (facts.notes ? `<p>${facts.notes.replace(/</g, '&lt;')}</p>` : '') +
      `<p>Open the attached calendar file to add this to your phone's calendar.</p>`;

    let sendError: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: invite.email,
          subject: `Processing day booked — ${whenText}`,
          html,
          // Explicit, not inferred from the filename: some mail apps only
          // offer "Add to Calendar" when the attachment is actually labelled
          // as a calendar object, rather than guessed from a .ics extension.
          attachments: [{
            filename: 'processing-day.ics',
            content: icsBase64,
            content_type: 'text/calendar; method=PUBLISH; charset=UTF-8',
          }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        sendError = `${res.status}: ${errText.slice(0, 300)}`;
      }
    } catch (e) {
      sendError = (e as Error).message;
    }

    if (sendError) {
      failed++;
    } else {
      sent++;
    }

    await userClient
      .from('processing_booking_invites')
      .update({
        sent_at: sendError ? null : new Date().toISOString(),
        sent_for_seq: sendError ? null : booking.sequence_no,
        error: sendError,
      })
      .eq('id', invite.id);
  }

  return json({ ok: true, sent, failed });
});
