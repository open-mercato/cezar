package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The page answers the start and resume checks read, and the resume check's verdicts. */
public class PageCheckTest {
    @Test
    public void readsEvaluateJavascriptAnswers() {
        assertEquals(PageCheck.PAINTED, PageCheck.state("\"painted\""));
        assertEquals(PageCheck.BLANK, PageCheck.state("\"blank\""));
        assertNull("a dead renderer answers null", PageCheck.state("null"));
        assertNull(PageCheck.state(null));
        assertNull(PageCheck.state("true"));
    }

    @Test
    public void onlyADrawnCockpitOrADirectSignInPageIsHealthy() {
        assertTrue(PageCheck.healthy(PageCheck.PAINTED, true));
        assertFalse(PageCheck.healthy(PageCheck.BLANK, false));
        assertTrue(PageCheck.healthy(PageCheck.PAGE, false));
        assertFalse(PageCheck.healthy(PageCheck.PAGE, true));
        assertFalse(PageCheck.healthy(null, false));
    }

    @Test
    public void aResumedPageThatStaysBlankIsRestartedOnce() {
        ResumeCheck check = new ResumeCheck(true);
        assertEquals(ResumeCheck.Verdict.HEALTHY, check.answer(null, 0));
        check.start(0);
        assertEquals(ResumeCheck.Verdict.WAIT, check.answer(null, 1000));
        assertEquals(ResumeCheck.Verdict.WAIT, check.answer(PageCheck.LOADING, ResumeCheck.WINDOW_MS - 1));
        assertEquals(ResumeCheck.Verdict.RESTART, check.answer(PageCheck.BLANK, ResumeCheck.WINDOW_MS));
        assertFalse(check.running());
        check.start(0);
        assertEquals(ResumeCheck.Verdict.HEALTHY, check.answer(PageCheck.PAINTED, 10));
        assertFalse(check.running());
    }
}
