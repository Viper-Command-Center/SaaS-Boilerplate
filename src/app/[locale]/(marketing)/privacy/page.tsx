import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { LegalPage } from '@/features/legal/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy Policy — Artivio',
  description: 'How Artivio collects, uses, shares, and protects your data, including WhatsApp and messaging data.',
};

const UPDATED = 'July 14, 2026';

export default async function PrivacyPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <p>
        This Privacy Policy explains how Artivio (&quot;we&quot;, &quot;us&quot;) collects, uses,
        shares, and protects information when you use the Artivio platform (the
        &quot;Service&quot;). By using the Service you agree to this Policy.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account information</strong>
          {' '}
          — name, email, password (stored hashed), and workspace membership.
        </li>
        <li>
          <strong>Content and data you provide</strong>
          {' '}
          — files you upload, instructions you give the agent, and data the agent
          generates for you.
        </li>
        <li>
          <strong>Connected-tool credentials</strong>
          {' '}
          — API keys and tokens for third-party services you choose to connect,
          stored encrypted and used only to perform tasks you request.
        </li>
        <li>
          <strong>Messaging information</strong>
          {' '}
          — if you opt in to WhatsApp, email, or SMS, we process the phone number
          or address, message content, and delivery status needed to send and
          receive those messages.
        </li>
        <li>
          <strong>Usage and technical data</strong>
          {' '}
          — logs of agent actions, tool usage and costs, IP address, and basic
          device information, used to operate, secure, and bill the Service.
        </li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>to provide, operate, and improve the Service and the agent;</li>
        <li>to perform the tasks and actions you request or schedule;</li>
        <li>to send you messages and notifications you have consented to receive;</li>
        <li>to meter usage, bill your account, and enforce spending limits;</li>
        <li>to secure the Service, detect abuse, and comply with legal obligations.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell your personal information, and we do not use
        the contents of your workspace to train third-party AI models.
      </p>

      <h2>3. WhatsApp and messaging data</h2>
      <p>
        When you connect WhatsApp, messages are delivered through Meta&apos;s WhatsApp
        Business Platform and our messaging provider (Twilio). Your phone number
        and message content are shared with these providers solely to deliver and
        receive your messages, subject to their privacy terms
        (<a href="https://www.whatsapp.com/legal/business-policy/" target="_blank" rel="noreferrer">WhatsApp Business</a>{' '}
        and <a href="https://www.twilio.com/legal/privacy" target="_blank" rel="noreferrer">Twilio</a>).
        We store the minimum necessary to operate the conversation and your
        opt-in/opt-out status. You can opt out at any time by replying
        {' '}
        <strong>STOP</strong>
        , after which we will not send further messages to that number.
      </p>

      <h2>4. How we share information</h2>
      <p>We share information only:</p>
      <ul>
        <li>
          with <strong>infrastructure and service providers</strong> that run the
          Service (e.g. cloud hosting, database, object storage, email and
          messaging delivery, AI model providers), under contracts limiting their
          use of the data to providing their service to us;
        </li>
        <li>
          with <strong>third-party tools you connect</strong>, as needed to perform
          the tasks you request;
        </li>
        <li>when required by law, or to protect the rights and safety of users;</li>
        <li>in connection with a business transfer, with notice to you.</li>
      </ul>
      <p>
        Key processors include Amazon Web Services (hosting, AI via Bedrock, cloud
        browser), Cloudflare R2 (file storage), Postmark (email), and Twilio /
        Meta (WhatsApp and SMS).
      </p>

      <h2>5. Data security</h2>
      <p>
        We use industry-standard measures to protect your data, including
        encryption of stored credentials, encryption in transit, workspace-level
        isolation so one workspace cannot access another&apos;s data, access controls,
        and audit logging. No system is perfectly secure, but we work to protect
        your information and to limit what any single component can access.
      </p>

      <h2>6. Data retention</h2>
      <p>
        We keep your information while your account is active and as needed to
        provide the Service. Generated media and certain artifacts may be
        retained in your file library until you delete them. When you delete a
        file or workspace, we remove the associated stored objects. Some records
        (e.g. billing and security logs) may be retained as required by law.
        Third-party providers may apply their own retention (for example,
        generated media at some AI providers is deleted after a set period, which
        is why Artivio archives your assets to your own storage).
      </p>

      <h2>7. Your rights and choices</h2>
      <ul>
        <li>access, correct, or delete your personal information;</li>
        <li>opt out of messaging at any time (reply STOP, unsubscribe, or in settings);</li>
        <li>disconnect any third-party tool and revoke its stored credential;</li>
        <li>request export or deletion of your workspace data.</li>
      </ul>
      <p>
        Depending on where you live (for example, the EU/UK or California), you
        may have additional rights under laws such as GDPR or the CCPA. To
        exercise any right, contact us at
        {' '}
        <a href="mailto:hello@artivio.ai">hello@artivio.ai</a>
        .
      </p>

      <h2>8. Children</h2>
      <p>
        The Service is not intended for anyone under 18, and we do not knowingly
        collect information from children.
      </p>

      <h2>9. International data</h2>
      <p>
        We operate primarily on infrastructure in the United States. If you access
        the Service from elsewhere, your information may be processed in the U.S.
        and other countries where our providers operate.
      </p>

      <h2>10. Changes</h2>
      <p>
        We may update this Policy. Material changes will be communicated through
        the Service or by email. The &quot;Last updated&quot; date above reflects the
        current version.
      </p>

      <h2>11. Contact</h2>
      <p>
        Questions or requests: <a href="mailto:hello@artivio.ai">hello@artivio.ai</a>.
      </p>
    </LegalPage>
  );
}

export const dynamic = 'force-static';
