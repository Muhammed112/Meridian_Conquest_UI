# Password-reset email template update rejection

The local `password-reset.html` contains the proposed replacement message.

**Project ID:** `meridian-conquest-m112`

The Identity Toolkit Admin v2 project-config API rejects this project's
password-reset template body update with HTTP 400:

```text
EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED
```

The email delivery method is `DEFAULT`, and no custom SMTP server is configured.
The attempted change updates only
`notification.sendEmail.resetPasswordTemplate.body` and
`notification.sendEmail.resetPasswordTemplate.bodyFormat` using their explicit
update mask. The replacement body retains `%DISPLAY_NAME%` and `%LINK%`.

The request was rejected on 1 November 2026. Reading the configuration afterward
confirmed the existing default message was unchanged.

The template-editing restriction remains unresolved; the default email delivery
setup is unchanged.
