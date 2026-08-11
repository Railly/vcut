### Invariants

Hard rules: each is a defect if it survives a pass, not a matter of taste. What makes them
rules is that they are stated about the **render** rather than about the plan, so they can be
checked after the fact instead of argued before it.

Being a rule is not the same as being mechanical, and pretending otherwise is how a checklist
gets ticked without being run. Only rule 8 is machine-decidable: `review` prints the list and
either it is empty or it is not. Rule 7 is decidable when the classifier is installed and a
listening task when it is not. Rules 1 through 6 are read by judgement, and their value is in
naming a defect precisely enough that you can tell whether you looked for it, not in removing
the judgement.

The right question at the end of a round is not "does this pass" but "did I check each of
these, and against what". A rule you did not look for reports the same as a rule that held.

1. **No idea is stated twice.** If two passages make the same point, one of them is a cut.
   Distance between them is not evidence they differ: the edit removes that distance.
2. **No sentence begins and does not land.** Every start has its ending in the edit, or the
   whole attempt goes.
3. **No pronoun outlives its antecedent.** If "that" or "eso" refers to something cut, the
   sentence goes with it.
4. **No fragment survives alone.** A clause that only made sense as part of a passage that
   was removed is not content, it is a leftover.
5. **Nothing survives that can be deleted without changing what the sentence says.** Delete
   the candidate, read what remains, and ask whether a listener learns anything less. If not,
   it goes.

   The test is a deletion, never a vocabulary. A word list only finds what someone already
   thought to write down, misses the same function expressed differently, and has to be
   rewritten for every language. The deletion test needs none of that: it asks what a span
   *does* in its sentence, so it works on a construction nobody named and in a language
   nobody wrote a list for.

   Sweep the transcript span by span rather than scanning for shapes you recognise. What you
   recognise is gone by the second pass; what stays is what did not look like filler, usually
   because it sits mid-clause and reads as ordinary grammar.

   Two things fail this test and must stay anyway: a word carrying emphasis the speaker
   meant, and a beat that gives a listener room before a heavy point. Removing those is what
   makes an edit sound like a script.
6. **The last line lands.** A video ending on an abandoned start is worse than one four
   seconds shorter.
7. **Nothing audible is left that is not language.** A breath, a mic bump, a lip smack. Both
   instruments are blind to these, so this one is not checkable by reading: it needs the
   classifier, and without it the check is a human ear.
8. **Every stretch has been read at least once.** Not a property of the edit but of the pass
   that made it, and the one that lets all the others survive: an unread stretch violates
   nothing visibly, because nobody looked. `review` reports these as `unreviewed`.

If the transcript of the render violates one of these, the edit is not done, whatever the
removal percentage says.

Rules 1 through 6 are read off the transcript. Rule 7 needs the audio. Rule 8 needs the EDL
and is the only one that says where to look rather than what to look for.

**`--crop` is not on this list.** Framing is taste and the document has no rule for it: pick
a crop when the source carries something the viewer should not see, leave it alone otherwise,
and let the human refuse it like any other proposal.
