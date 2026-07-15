import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { LegalPage } from '@/features/legal/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of Service — Artivio',
  description: 'The terms governing use of the Artivio AI platform, including automated actions and messaging.',
};

const UPDATED = 'July 14, 2026';

export default async function TermsPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <LegalPage title="Terms of Service" updated={UPDATED}>
      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and use of Artivio
        (the &quot;Service&quot;), operated by Artivio (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;). By creating an
        account or using the Service, you agree to these Terms. If you do not
        agree, do not use the Service.
      </p>

      <h2>1. What Artivio is</h2>
      <p>
        Artivio is a multi-tenant platform that provides an AI assistant
        (&quot;agent&quot;) for each workspace. The agent can perform marketing and
        operational tasks, connect to third-party tools you authorize, generate
        content, and — where you enable it — take actions on your behalf. Some
        actions are performed automatically; many require your explicit approval
        before they take effect.
      </p>

      <h2>2. Your account</h2>
      <p>
        Access is currently invitation-based. You are responsible for keeping
        your credentials secure, for all activity under your account, and for
        the accuracy of information you provide. You must be at least 18 years
        old and authorized to bind any business you represent.
      </p>

      <h2>3. Automated actions and your responsibility</h2>
      <p>
        The agent acts on your instructions and standing configuration,
        including scheduled &quot;missions&quot; that run without a person present. You are
        responsible for reviewing and approving actions that have real-world
        effect (publishing content, changing websites, spending money, sending
        messages). Actions you route through the approvals system take effect
        only after you approve them. You remain responsible for the content the
        agent produces or publishes under your direction, and for ensuring it is
        lawful, accurate, and appropriate.
      </p>

      <h2>4. Third-party tools and connections</h2>
      <p>
        You may connect third-party services (via MCP servers, plugins, API
        keys, or OAuth). Your use of those services is governed by their own
        terms, and you are responsible for having the right to connect and use
        them. Credentials you provide are stored encrypted and used only to
        perform the tasks you request. We are not responsible for the
        availability, accuracy, or actions of third-party services.
      </p>

      <h2>5. Messaging (WhatsApp, email, SMS)</h2>
      <p>
        With your consent, your agent may communicate with you and with contacts
        you designate through channels such as WhatsApp, email, or SMS. You may
        only provide contact details for people who have consented to be
        contacted. Message and data rates may apply. You can opt out at any time
        by replying <strong>STOP</strong> to a WhatsApp or SMS message, using an
        unsubscribe link in email, or updating your notification settings. See
        our <a href="/privacy">Privacy Policy</a> for how message data is handled.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You agree not to use the Service to:</p>
      <ul>
        <li>break the law, infringe others&apos; rights, or violate a third party&apos;s terms;</li>
        <li>send spam or unsolicited messages, or contact people without their consent;</li>
        <li>generate deceptive, harmful, hateful, or unlawful content;</li>
        <li>attempt to access another workspace&apos;s data, or probe, scan, or breach the Service;</li>
        <li>misuse connected tools or exceed rate limits of third-party providers.</li>
      </ul>

      <h2>7. Fees and usage</h2>
      <p>
        Certain features (AI generation, media creation, browser automation, and
        other metered tools) incur usage-based costs. Where applicable, these are
        billed to your account at the rates shown in your workspace. You are
        responsible for usage under your account, including automated usage from
        scheduled missions, subject to any spending caps you or we configure.
      </p>

      <h2>8. Intellectual property</h2>
      <p>
        You retain ownership of the content and data you provide and the output
        the agent produces for you, subject to the rights of any third-party
        tools involved. We retain ownership of the Service itself. You grant us
        the limited right to process your content solely to operate the Service.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        The Service is provided &quot;as is&quot;. AI output can be inaccurate or
        incomplete; you should review it before relying on it. We do not warrant
        that the Service will be uninterrupted or error-free. Nothing the agent
        produces is legal, financial, medical, or professional advice.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, we are not liable for indirect,
        incidental, or consequential damages, or for actions taken by the agent
        that you authorized or configured. Our total liability for any claim is
        limited to the amount you paid us in the three months before the claim.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may stop using the Service at any time. We may suspend or terminate
        access for violation of these Terms or to protect the Service or other
        users. On termination, we will delete or return your data as described in
        the <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these Terms. Material changes will be communicated through
        the Service or by email. Continued use after a change means you accept
        the updated Terms.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions about these Terms: <a href="mailto:hello@artivio.ai">hello@artivio.ai</a>.
      </p>
    </LegalPage>
  );
}

export const dynamic = 'force-static';
