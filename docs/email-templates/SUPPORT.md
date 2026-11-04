# Password-reset email template update rejected

Copy the following into a Firebase Authentication support case and attach
`password-reset.html` from this directory.

**Project ID:** `meridian-conquest-m112`

Please review the restriction preventing password-reset email template updates
for this project. The Identity Toolkit Admin v2 project-config API rejects a
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

Please advise how to enable password-reset message customisation for this project
or apply the attached message while preserving the current email delivery setup.
