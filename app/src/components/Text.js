import { forwardRef } from 'react'
import { Platform, Text as RNText } from 'react-native'

// 웹 번들의 기본 글 스타일 - 어절(띄어쓰기) 안에서는 끊지 않고, 한 어절이 한 줄보다 길 때만 끊는다
const WEB_WORD_STYLE = { wordBreak: 'keep-all', overflowWrap: 'break-word' }

// 한글 어절 단위 줄바꿈을 켠 Text - 웹은 keep-all, iOS 는 hangul-word (호출자 prop·style 이 이긴다)
export const Text = forwardRef(function Text({ style, ...rest }, ref) {
  return (
    <RNText
      lineBreakStrategyIOS="hangul-word"
      {...rest}
      ref={ref}
      style={Platform.OS === 'web' ? [WEB_WORD_STYLE, style] : style}
    />
  )
})

export default Text
