### Fixed

- Fill a saved authenticator code from the Vault into a sign-in page that splits the code into one
  box for each digit, such as six boxes named "1 digit" to "6 digit". Before, a person had to type
  the code. This works once, as the step right after OpenBot filled the saved password of the same
  site in the same tab, within 5 minutes. The boxes must be in one row, take one character each,
  and have their own digit names. They must be in a part of the page that names an authenticator app
  and has no other text field, and the page must have no payment, transfer or approval words. Other
  digit boxes, such as those of a payment approval, still ask the user.
- Block a navigation that would send a saved code in parts in its address, as a form of digit boxes
  that sends with GET does. The user then finishes in the tab.
