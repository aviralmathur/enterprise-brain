## What this changes

<!-- One or two sentences. Which tree does it touch — skills/ or platform/? -->

## The check that proves it

<!-- A fix names the check that was RED before it. A feature names the check that
     shows the prose is now true. "A phase that cannot pass its check has not
     shipped." If there is no check, say why. -->

## Checklist

- [ ] `cd platform && node acceptance/run.mjs` is green
- [ ] `bash validate.sh --example` is clean (if the kit changed)
- [ ] No real fleet / org / person / host / path / figure in the diff (public repo)
- [ ] Routing and fleet-wide rules still have exactly one home each
