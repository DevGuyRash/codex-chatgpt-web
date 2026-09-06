# Fork integration

This fork's behavior, improvements and user choices are the baseline for evaluating upstream changes. A newer upstream commit or release is a candidate, not evidence that replacing the fork is an improvement.

Before integrating upstream changes, an agent SHALL review the proposed changes against the fork baseline. You SHALL NOT integrate unreviewed upstream changes or changes that materially worsen this setup. Resolve material review findings and run verification appropriate to the affected behavior before integration; a review of an earlier candidate does not cover subsequent changes to its behavior.

Record the reviewed upstream revision, accepted and excluded scope, and verification evidence in repository documentation. Selective ports, adapted fixes and intentional divergence are valid outcomes. Do not merge rejected changes merely to make Git ancestry appear synchronized, and do not describe passing tests as proof of universal bug-freedom.
