from bench_refine import *
TUNED = open("/tmp/tuned_prompt.txt").read().strip()
LONG = ("Значит, смотри, короче, я вчера, э, разговаривал с Димой по поводу, ну, по поводу проекта, и он сказал, что, в общем, они не успевают к пятнице, нет, к понедельнику, потому что, это самое, у них там сломался сервер, ну и, типа, нужно ещё два дня минимум. "
 "Я ему сказал, что, ну, ладно, мы подождём, но, э, надо будет, чтобы он нам обязательно написал в среду, как у них идут дела. И ещё, слушай, надо не забыть, что нам нужно, это, обновить договор с подрядчиком, там срок заканчивается, ну, в конце месяца, и если мы не продлим, то, короче, будут проблемы с оплатой. "
 "Так что давай ты, э, возьмёшь это на себя, ага, а я займусь, ну, презентацией для инвесторов, которую мне надо сделать до четверга.")
print("long words", len(LONG.split()))
c = Conn()
for model, eff, pr, pn in (("grok-4.20-0309-non-reasoning",None,TUNED,"tuned"),("grok-4.3","none",TUNED,"tuned"),("grok-4.7","low",CUR,"cur")):
    for st in (False, True):
        tt=[]; tf=[]
        for i in range(3):
            r, out, us = call(c, model, eff, pr, LONG, st)
            tt.append(r["total"]); tf.append(r["first_tok"] if st else r["ttfb"])
        print(f"LONG {model} {pn} stream={st}: ttft p50 {pct(tf,.5):.2f} total p50 {pct(tt,.5):.2f} (min {min(tt):.2f} max {max(tt):.2f}) out_tokens={us and us.get('output_tokens')}")
print(out)
